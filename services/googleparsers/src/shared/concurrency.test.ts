import assert from "node:assert/strict";
import test from "node:test";
import { runConcurrentPool } from "./concurrency.js";

test("runConcurrentPool limits the number of active tasks", async () => {
  let active = 0;
  let maxActive = 0;
  const completed: number[] = [];

  await runConcurrentPool([0, 1, 2, 3, 4, 5], 3, async (item) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    completed.push(item);
    active -= 1;
  });

  assert.equal(maxActive, 3);
  assert.deepEqual(completed.sort((a, b) => a - b), [0, 1, 2, 3, 4, 5]);
});

test("runConcurrentPool stops assigning new tasks after stop is requested", async () => {
  let completed = 0;
  let stopped = false;

  await runConcurrentPool(
    [0, 1, 2, 3, 4, 5],
    2,
    async () => {
      completed += 1;
      stopped = true;
    },
    () => stopped
  );

  assert.equal(completed, 1);
});

test("runConcurrentPool falls back to one worker for invalid concurrency", async () => {
  let active = 0;
  let maxActive = 0;

  await runConcurrentPool([0, 1], Number.NaN, async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
  });

  assert.equal(maxActive, 1);
});
