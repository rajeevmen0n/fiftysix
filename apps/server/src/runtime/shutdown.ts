export interface ShutdownParticipant {
  close(): void | Promise<void>;
}

export interface ShutdownCoordinator {
  add(participant: ShutdownParticipant): () => void;
  close(): Promise<void>;
}

export function createShutdownCoordinator(): ShutdownCoordinator {
  const participants: ShutdownParticipant[] = [];
  let closePromise: Promise<void> | null = null;

  return {
    add(participant) {
      if (closePromise !== null) {
        throw new Error("Shutdown has already started");
      }

      participants.push(participant);
      let registered = true;

      return () => {
        if (!registered || closePromise !== null) {
          return;
        }

        registered = false;
        const index = participants.indexOf(participant);
        if (index !== -1) {
          participants.splice(index, 1);
        }
      };
    },
    close() {
      closePromise ??= (async () => {
        let firstError: unknown;

        for (const participant of participants) {
          try {
            await participant.close();
          } catch (error) {
            firstError ??= error;
          }
        }

        if (firstError !== undefined) {
          throw firstError;
        }
      })();

      return closePromise;
    },
  };
}
