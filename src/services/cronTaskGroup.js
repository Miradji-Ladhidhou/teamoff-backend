'use strict';

function createCronTaskGroup(cron) {
  const tasks = new Set();
  const running = new Set();
  let stopping = false;
  let stopPromise;

  function schedule(expression, handler) {
    if (stopping) throw new Error('Groupe cron arrêté.');
    const task = cron.schedule(expression, async () => {
      if (stopping) return;
      const execution = Promise.resolve().then(handler);
      running.add(execution);
      try {
        await execution;
      } finally {
        running.delete(execution);
      }
    });
    tasks.add(task);
    return task;
  }

  function stop() {
    if (stopPromise) return stopPromise;
    stopping = true;
    stopPromise = (async () => {
      const errors = [];
      for (const task of tasks) {
        try { await task.stop(); } catch (error) { errors.push(error); }
        try { await task.destroy(); } catch (error) { errors.push(error); }
      }
      tasks.clear();
      const executions = await Promise.allSettled([...running]);
      errors.push(...executions.filter(result => result.status === 'rejected').map(result => result.reason));
      if (errors.length) throw new AggregateError(errors, 'Arrêt du groupe cron incomplet.');
    })();
    return stopPromise;
  }

  async function remove(task) {
    const errors = [];
    try { await task.stop(); } catch (error) { errors.push(error); }
    try { await task.destroy(); } catch (error) { errors.push(error); }
    tasks.delete(task);
    if (errors.length) throw new AggregateError(errors, 'Arrêt de la tâche cron incomplet.');
  }

  return { schedule, stop, remove };
}

module.exports = { createCronTaskGroup };
