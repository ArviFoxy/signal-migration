// The parts every state machine of the app is made of.
//
// A machine's state is a union of variants, each with a `kind`. Each variant is its own module, with a table of
// handlers: for each event the variant accepts, a pure function from the state and the event to the next state.
// Sub-machines use `ExhaustiveVariantHandlers` + `byExhaustiveVariant` so every event must be explicitly handled
// or marked `IGNORE` — preventing new events or failure modes from being silently dropped in a variant.
//
// What a state waits for (TDLib, Signal, a timer) is background work. A state does not start work: it describes the
// work that runs while it holds, as data (`Work`), and the runtime (runtime.ts) starts what a new state describes,
// cancels what it no longer describes, and ignores what cancelled work still reports.

/** Explicit marker in an exhaustive handler table meaning this variant intentionally ignores the event. */
export const IGNORE = null;

/** The variant of union `S` whose kind is `K`. */
export type Variant<S extends { kind: string }, K extends S['kind']> = Extract<S, { kind: K }>;

/** The event of union `E` whose type is `T`. */
export type EventOf<E extends { type: string }, T extends E['type']> = Extract<E, { type: T }>;

/** One variant's handlers (partial table, used by the top-level app machine that delegates sub-machine events). */
export type VariantHandlers<S extends { kind: string }, K extends S['kind'], E extends { type: string }, C> = {
  [T in E['type']]?: (state: Variant<S, K>, event: EventOf<E, T>, context: C) => S;
};

/** One variant's exhaustive handlers: every event of the machine must be handled or explicitly marked `IGNORE`. */
export type ExhaustiveVariantHandlers<
  S extends { kind: string },
  K extends S['kind'],
  E extends { type: string },
  C,
> = {
  [T in E['type']]: ((state: Variant<S, K>, event: EventOf<E, T>, context: C) => S) | typeof IGNORE;
};

/** Every variant's handlers. */
export type Handlers<S extends { kind: string }, E extends { type: string }, C> = {
  [K in S['kind']]: VariantHandlers<S, K, E, C>;
};

/** Every variant's exhaustive handlers. */
export type ExhaustiveHandlers<S extends { kind: string }, E extends { type: string }, C> = {
  [K in S['kind']]: ExhaustiveVariantHandlers<S, K, E, C>;
};

/** The transition function made of every variant's handlers. */
export function byVariant<S extends { kind: string }, E extends { type: string }, C>(
  handlers: Handlers<S, E, C>,
): (state: S, event: E, context: C) => S {
  return (state, event, context) => {
    const table = handlers[state.kind as S['kind']] as Record<string, ((s: S, e: E, c: C) => S) | undefined>;
    const handler = table[event.type];
    return handler ? handler(state, event, context) : state;
  };
}

/** The transition function made of exhaustive variant handler tables (compile-time check for every event). */
export function byExhaustiveVariant<S extends { kind: string }, E extends { type: string }, C>(
  handlers: ExhaustiveHandlers<S, E, C>,
): (state: S, event: E, context: C) => S {
  return (state, event, context) => {
    const table = handlers[state.kind as S['kind']] as Record<
      string,
      ((s: S, e: E, c: C) => S) | typeof IGNORE | undefined
    >;
    const handler = table[event.type];
    return handler ? handler(state, event, context) : state;
  };
}

/** What a transition may use besides the state and the event: values the runtime draws for it. */
export type Context = {
  /** 16 random hexadecimal digits, new for every event; names new TDLib instances and Signal device lifetimes. */
  nonce: string;
};
