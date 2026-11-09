/**
 * What a person records on the steps of a request that they do steps. The
 * Worker applies it to the stored steps, and the web app's fixture to its
 * own, so both keep one rule: a step is to do, done or stuck.
 */
import type { StepMark, TaskStep } from './task.ts';

/** What a person records on one step. A field left out stays as it is. */
export interface StepMarking {
  /** The step's place in the request, from 1. */
  readonly step: number;
  /** true ticks the step, false unticks it. */
  readonly done?: boolean;
  /** Their note on the step, such as a value the agent asked for; null takes it off. */
  readonly note?: string | null;
  /** Why they stopped at this step; null says they are past it. */
  readonly stuck?: string | null;
}

/** The step as `marking` leaves it, each new mark made as `mark` says. A tick
 * clears a stuck mark and a stuck mark clears a tick. The same step comes
 * back when the marking changes nothing. */
export function markedStep(step: TaskStep, marking: StepMarking, mark: StepMark): TaskStep {
  let next = step;
  if (marking.done === true && next.done === null) next = { ...next, done: mark, stuck: null };
  if (marking.done === false && next.done !== null) next = { ...next, done: null };
  if (marking.note === null && next.note !== null) next = { ...next, note: null };
  if (typeof marking.note === 'string' && next.note?.text !== marking.note)
    next = { ...next, note: { ...mark, text: marking.note } };
  if (marking.stuck === null && next.stuck !== null) next = { ...next, stuck: null };
  if (typeof marking.stuck === 'string' && (next.stuck?.reason !== marking.stuck || next.done !== null))
    next = { ...next, done: null, stuck: { ...mark, reason: marking.stuck } };
  return next;
}
