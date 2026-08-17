/**
 * Retries reads that D1 failed for reasons that are not about the query.
 *
 * A crawl of /members/:slug once produced a burst of 500s where the failing
 * statement was a primary-key lookup returning at most one row - a query that
 * cannot be slow, large, or wrong. Cloudflare documents this class of D1
 * failure (a node reset, a lost connection, a replica losing its primary) and
 * prescribes the same response to all of it: try again.
 *
 * Wrapping the binding, rather than each of the two dozen query functions,
 * puts the decision in the one place every query already passes through.
 */

/**
 * The failures worth repeating: D1 dropped the request, not the query.
 *
 * Deliberately narrow. The overload messages ("Requests queued for too long",
 * "Too many requests queued") are excluded even though they are transient,
 * because a retry sends a database that is already behind more work. So are
 * the row-limit and timeout messages, which repeat identically. Anything not
 * listed here fails on the first attempt, as it did before.
 */
const TRANSIENT = [
  'Network connection lost',
  'storage caused object to be reset',
  'transient issue on remote node',
  'Replica disconnected from primary',
  'reset because its code was updated',
];

/** Two retries, far enough apart for a reset object to come back up. */
const BACKOFF_MS = [50, 200];

/**
 * Reads only. A write that failed after D1 applied it would be repeated by a
 * retry, and an audit row or a subscriber would be duplicated. Reads have no
 * such second meaning.
 */
const IS_READ = /^\s*select\b/i;

/** Lets `batch` recover the statement D1 will actually accept. */
const NATIVE = Symbol('native D1 statement');

const isTransient = (err: unknown) =>
  err instanceof Error && TRANSIENT.some((marker) => err.message.includes(marker));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function attempt<T>(run: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await run();
    } catch (err) {
      if (i === BACKOFF_MS.length || !isTransient(err)) throw err;
      await sleep(BACKOFF_MS[i]!);
    }
  }
}

/**
 * `bind` returns a new statement, so the wrapper has to reapply itself; the
 * cast is because the wrapper stands in for an abstract class whose `first`
 * and `raw` are overloaded, and structural typing will not carry that across.
 */
const retrying = (stmt: D1PreparedStatement): D1PreparedStatement =>
  ({
    [NATIVE]: stmt,
    bind: (...values: unknown[]) => retrying(stmt.bind(...values)),
    first: (colName?: string) =>
      attempt(() => (colName === undefined ? stmt.first() : stmt.first(colName))),
    run: () => attempt(() => stmt.run()),
    all: () => attempt(() => stmt.all()),
    raw: (options?: { columnNames?: boolean }) => attempt(() => stmt.raw(options as never)),
  }) as unknown as D1PreparedStatement;

const native = (stmt: D1PreparedStatement): D1PreparedStatement =>
  (stmt as unknown as Record<symbol, D1PreparedStatement>)[NATIVE] ?? stmt;

/**
 * Every member is forwarded by hand. A native binding keeps its methods on a
 * prototype, so spreading it would produce an object missing most of them and
 * fail only at the call site that happened to need one.
 */
export function withReadRetry(binding: D1Database): D1Database {
  return {
    exec: (query: string) => binding.exec(query),
    withSession: (constraintOrBookmark?: Parameters<D1Database['withSession']>[0]) =>
      binding.withSession(constraintOrBookmark),
    dump: () => binding.dump(),

    prepare: (sql: string) => {
      const stmt = binding.prepare(sql);
      return IS_READ.test(sql) ? retrying(stmt) : stmt;
    },
    // A batch is atomic and may carry writes, so it is passed through
    // untouched - but the statements in it came from `prepare` above and are
    // wrappers, which D1 itself will not accept.
    batch: <T = Record<string, unknown>>(statements: D1PreparedStatement[]) =>
      binding.batch<T>(statements.map(native)),
  } as D1Database;
}
