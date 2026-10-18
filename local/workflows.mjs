// Durable local implementation of the Workflow binding. Domain records remain authoritative.
export function createLocalWorkflows({database, execute, now = Date.now, logger = console.info}) {
  const {sqlite, transactionSync} = database;
  sqlite.exec(`CREATE TABLE IF NOT EXISTS local_workflows (id TEXT PRIMARY KEY, payload TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, output TEXT, error TEXT) STRICT;
    CREATE TABLE IF NOT EXISTS local_workflow_steps (id TEXT NOT NULL, generation INTEGER NOT NULL, name TEXT NOT NULL, result TEXT, deadline INTEGER, PRIMARY KEY(id,generation,name)) STRICT;
    CREATE TABLE IF NOT EXISTS local_workflow_events (sequence INTEGER PRIMARY KEY, id TEXT NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL) STRICT;`);
  // An interrupted model request is not silently replayed; the existing recovery policy handles it.
  sqlite.prepare("UPDATE local_workflows SET status='errored',error='WorkflowExecutionStopped' WHERE status='running'").run();
  const active = new Map(), wake = new Map(), timers = new Set();
  let closed = false;
  const rowFor = id => { const row=sqlite.prepare('SELECT * FROM local_workflows WHERE id=?').get(id); if(!row) throw new Error('WorkflowInstanceMissing'); return row; };
  const signal = id => { wake.get(id)?.(); wake.delete(id); };
  const state = (id,status) => sqlite.prepare('UPDATE local_workflows SET status=? WHERE id=?').run(status,id);
  async function wait(id, deadline) {
    if (closed) return new Promise(() => {});
    await new Promise(resolve => {
      const timer = setTimeout(() => { timers.delete(timer); wake.delete(id); resolve(); },Math.min(Math.max(1,deadline-now()),2_147_483_647));
      timer.unref(); timers.add(timer);
      wake.set(id,() => { clearTimeout(timer); timers.delete(timer); resolve(); });
    });
  }
  function launch(id) {
    if(closed || active.has(id)) return;
    const initial = rowFor(id), generation=initial.generation;
    if(initial.status==='paused'||initial.status==='terminated')return;
    state(id,'running');
    const current = () => {
      if(closed) throw new Error('WorkflowServerClosed');
      const row=rowFor(id);
      if(row.generation!==generation||row.status==='terminated')throw new Error('WorkflowTerminated');
      return row;
    };
    const before = async () => {
      while(current().status==='paused')await wait(id,now()+86_400_000);
    };
    const stored = name => sqlite.prepare('SELECT * FROM local_workflow_steps WHERE id=? AND generation=? AND name=?').get(id,generation,name);
    const save = (name,result) => sqlite.prepare('INSERT INTO local_workflow_steps(id,generation,name,result) VALUES(?,?,?,?) ON CONFLICT(id,generation,name) DO UPDATE SET result=excluded.result').run(id,generation,name,JSON.stringify({value:result}));
    const step = {
      async do(name, config, callback) {
        await before();
        const previous = stored(name);
        if(previous?.result!==null&&previous?.result!==undefined)return JSON.parse(previous.result).value;
        const value=await (callback??config)();
        current(); save(name,value); return value;
      },
      async waitForEvent(name,{type,timeout}) {
        await before();
        const previous=stored(name);
        if(previous?.result)return JSON.parse(previous.result).value;
        // The shared executor uses a 24-hour consent/control timeout.
        if(timeout!=='24 hours')throw new TypeError('Workflow wait timeout is unsupported.');
        const deadline=previous?.deadline??now()+86_400_000;
        sqlite.prepare('INSERT INTO local_workflow_steps(id,generation,name,deadline) VALUES(?,?,?,?) ON CONFLICT DO NOTHING').run(id,generation,name,deadline);
        for(;;) {
          await before();
          const event=transactionSync(() => {
            const next=sqlite.prepare('SELECT sequence,payload FROM local_workflow_events WHERE id=? AND type=? ORDER BY sequence LIMIT 1').get(id,type);
            if(next) { sqlite.prepare('DELETE FROM local_workflow_events WHERE sequence=?').run(next.sequence); save(name,JSON.parse(next.payload)); }
            return next;
          });
          if(event){state(id,'running');return JSON.parse(event.payload);}
          if(now()>=deadline)throw new Error('WorkflowEventTimeout');
          state(id,'waiting'); await wait(id,deadline);
        }
      },
      async sleepUntil(name,date) {
        await before();
        const previous=stored(name);
        if(previous?.result)return;
        const deadline=previous?.deadline??date.getTime();
        if(!Number.isFinite(deadline))throw new TypeError('Workflow sleep deadline is invalid.');
        sqlite.prepare('INSERT INTO local_workflow_steps(id,generation,name,deadline) VALUES(?,?,?,?) ON CONFLICT DO NOTHING').run(id,generation,name,deadline);
        while(now()<deadline){await before();state(id,'waiting');await wait(id,deadline);}
        await before();state(id,'running');save(name,null);
      },
    };
    const job = Promise.resolve().then(() => execute({payload:JSON.parse(initial.payload)},step)).then(output => {
      current();sqlite.prepare("UPDATE local_workflows SET status='complete',output=?,error=NULL WHERE id=? AND generation=?").run(JSON.stringify(output),id,generation);
    }).catch(error => {
      if(closed)return;
      const row=rowFor(id);
      if(row.generation!==generation||row.status==='terminated')return;
      sqlite.prepare("UPDATE local_workflows SET status='errored',error=? WHERE id=?").run(error instanceof Error?error.message:'WorkflowExecutionStopped',id);
      logger(JSON.stringify({event:'local-workflow-failure',instanceId:id,failureKind:'WorkflowExecutionStopped'}));
    }).finally(() => active.delete(id));
    active.set(id,job);
  }
  function instance(id) {
    rowFor(id);
    return {
      id,
      async status(){const row=rowFor(id);return {status:row.status,...(row.output?{output:JSON.parse(row.output)}:{})};},
      async pause(){state(id,'paused');},
      async resume(){state(id,'running');signal(id);launch(id);},
      async restart(){
        if(active.has(id))throw new Error('WorkflowInstanceBusy');
        sqlite.prepare("UPDATE local_workflows SET generation=generation+1,status='running',output=NULL,error=NULL WHERE id=?").run(id);
        launch(id);
      },
      async terminate(){state(id,'terminated');signal(id);},
      async sendEvent(event){
        const row=rowFor(id);
        if(row.status==='paused')throw new Error('WorkflowInstancePaused');
        if(['complete','terminated','errored'].includes(row.status))throw new Error('WorkflowInstanceNotWaiting');
        sqlite.prepare('INSERT INTO local_workflow_events(id,type,payload) VALUES(?,?,?)').run(id,event.type,JSON.stringify(event.payload??{}));
        signal(id);launch(id);
      },
    };
  }
  return {
    async create({id,params}){sqlite.prepare("INSERT INTO local_workflows(id,payload,status) VALUES(?,?,'running')").run(id,JSON.stringify(params));launch(id);return instance(id);},
    async get(id){return instance(id);},
    restore(){for(const row of sqlite.prepare("SELECT id FROM local_workflows WHERE status='waiting'").all())launch(row.id);},
    async close(){closed=true;for(const timer of timers)clearTimeout(timer);timers.clear();for(const notify of wake.values())notify();wake.clear();await Promise.allSettled([...active.values()]);},
    async settled(id){await active.get(id);},
  };
}
