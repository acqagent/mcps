// Stands in for the "cloudflare:workers" module under Node (see vitest.config.ts).

export class DurableObject<Env = unknown> {
  constructor(
    protected ctx: DurableObjectState,
    protected env: Env,
  ) {}
}
