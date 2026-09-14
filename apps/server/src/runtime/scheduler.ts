import type { Clock } from "./clock.js";

export interface ScheduledTask {
  cancel(): void;
}

export interface Scheduler {
  at(deadline: number, callback: () => void | Promise<void>): ScheduledTask;
  close(): void;
}

export function createSystemScheduler(clock: Clock): Scheduler {
  const timers = new Set<NodeJS.Timeout>();
  let closed = false;

  return {
    at(deadline, callback) {
      if (closed) {
        throw new Error("Scheduler is closed");
      }

      let timer: NodeJS.Timeout | undefined = setTimeout(
        () => {
          if (timer !== undefined) {
            timers.delete(timer);
            timer = undefined;
          }
          void callback();
        },
        Math.max(0, deadline - clock.now()),
      );
      timers.add(timer);

      return {
        cancel() {
          if (timer === undefined) {
            return;
          }

          clearTimeout(timer);
          timers.delete(timer);
          timer = undefined;
        },
      };
    },
    close() {
      closed = true;
      for (const timer of timers) {
        clearTimeout(timer);
      }
      timers.clear();
    },
  };
}
