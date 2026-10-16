// @ts-check

// Match the existing knowledge-review ceiling and leave connections for persistence.
export const QUIZ_PIPELINE_WIDTH = 3;

/** Refill a freed slot immediately; review/publication retain source order.
 * @template T,U
 * @param {readonly T[]} points
 * @param {(point:T,awaitReview:()=>Promise<void>)=>Promise<U>} process
 * @param {()=>boolean} [canStart]
 * @returns {Promise<U[]>} */
export async function runQuizPipeline(points, process, canStart=()=>true) {
  let previous=Promise.resolve(),next=0,stopped=false;
  /** @type {PromiseSettledResult<U>[]} */const results=[];
  async function worker() {
    while(!stopped&&next<points.length&&canStart()) {
      const index=next++;
      const turn=previous;
      let release=()=>{};
      previous=new Promise(resolve=>{release=resolve;});
      try {results[index]={status:'fulfilled',value:await process(points[index],()=>turn)};}
      catch(reason){stopped=true;results[index]={status:'rejected',reason};}
      finally {
        // Failure must not let later reviews bypass an earlier unfinished commit.
        await turn;release();
      }
    }
  }
  const workers=await Promise.allSettled(Array.from({length:Math.min(points.length,QUIZ_PIPELINE_WIDTH)},()=>worker().catch(error=>{stopped=true;throw error;})));
  for(const worker of workers)if(worker.status==='rejected')throw worker.reason;
  return results.map(result=>{
    if(result.status==='rejected')throw result.reason;
    return result.value;
  });
}
