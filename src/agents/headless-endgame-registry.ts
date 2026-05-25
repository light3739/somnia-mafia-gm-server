/**
 * agents/headless-endgame-registry.ts — Module-level registry for the headless
 * endgame finalizer function.
 *
 * Allows nightRoutes.ts (which doesn't import index.ts to avoid circular deps)
 * to fire-and-forget a headless finalize check after a successful doResolveNight,
 * without a hard compile-time dependency on the agents subsystem.
 *
 * Usage:
 *   // agents/index.ts:
 *   setHeadlessFinalizer(finalizeHeadlessWin);
 *
 *   // nightRoutes.ts (dynamic import to avoid circular dep):
 *   getHeadlessFinalizer()?.(chainId, roomId).catch(...)
 */

type Finalizer = (chainId: number, roomId: string) => Promise<string>;

let _finalizer: Finalizer | undefined;

export const setHeadlessFinalizer = (f: Finalizer): void => {
  _finalizer = f;
};

export const getHeadlessFinalizer = (): Finalizer | undefined => _finalizer;
