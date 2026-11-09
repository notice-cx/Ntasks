/** Every check, by level, in the order the report lists them. */
import type { Check } from '../check.ts';
import { bindings } from './bindings.ts';
import { core } from './core.ts';
import { delivery } from './delivery.ts';
import { human } from './human.ts';
import { live } from './live.ts';

export const checks: readonly Check[] = [...core, ...human, ...delivery, ...live, ...bindings];
