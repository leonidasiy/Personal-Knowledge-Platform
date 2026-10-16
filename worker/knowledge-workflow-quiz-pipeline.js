// @ts-check

// Match the existing knowledge-review ceiling and leave connections for persistence.
export const QUIZ_PIPELINE_WIDTH = 3;

/** Drafts overlap; review and publication observe earlier committed results.
 * @template T,U
 * @param {readonly T[]} points
 * @param {(point:T,awaitReview:()=>Promise<void>)=>Promise<U>} process
 * @returns {Promise<U[]>} */
export async function runQuizPipeline(points, process) {
  let previous = Promise.resolve();
  const settled = await Promise.allSettled(points.slice(0, QUIZ_PIPELINE_WIDTH).map(point => {
    const turn = previous;
    let release = () => {};
    previous = new Promise(resolve => { release = resolve; });
    return (async () => {
      try { return await process(point, () => turn); }
      finally {
        // A failed generator must not let later reviews bypass an earlier point.
        await turn;
        release();
      }
    })();
  }));
  return settled.map(result => {
    if (result.status === 'rejected') throw result.reason;
    return result.value;
  });
}
