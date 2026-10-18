import type { Hook } from "./hook";

export type Env = {
  HOOKS: DurableObjectNamespace<Hook>;
  CREATES: RateLimit;
  LOOKUPS: RateLimit;
  HOOK_DOMAIN: string;
  HOOK_TOKEN?: string;
};
