/**
 * Flattens an error and its `cause` chain into something a log can carry.
 *
 * Drizzle wraps every failed query in a `DrizzleQueryError` whose message is
 * the SQL and nothing else; the error D1 actually raised is on `cause`.
 * Cloudflare's trace events serialise an exception's name, message and stack -
 * not `cause` - so an uncaught query failure reaches Workers Logs with the
 * reason already discarded. A burst of 500s on /members/:slug was diagnosable
 * only as far as "some query on this line failed" because of that.
 */

type Described = { name: string; message: string };

/**
 * `Failed query: <sql>\nparams: <values>`. The values are dropped: bound
 * parameters carry subscriber addresses and members' names, and the request
 * path - which is what actually identifies the request - is logged beside
 * this anyway.
 */
const BOUND_PARAMS = /\nparams:[\s\S]*$/;

/** Deep enough for a wrapped driver error; short enough to stay readable. */
const MAX_CAUSES = 5;

const describe = (value: unknown): Described =>
  value instanceof Error
    ? { name: value.name, message: value.message.replace(BOUND_PARAMS, '') }
    : { name: typeof value, message: String(value) };

export function describeError(err: unknown): Described & { causes: Described[] } {
  const causes: Described[] = [];
  // A cause chain is not guaranteed to be acyclic, and a log line is not worth
  // hanging the request over.
  const seen = new Set<unknown>([err]);

  let cause = err instanceof Error ? err.cause : undefined;
  while (cause != null && causes.length < MAX_CAUSES && !seen.has(cause)) {
    seen.add(cause);
    causes.push(describe(cause));
    cause = cause instanceof Error ? cause.cause : undefined;
  }

  return { ...describe(err), causes };
}
