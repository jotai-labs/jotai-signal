/// <reference types="react/experimental" />

import ReactExports, {
  createElement as createElementOrig,
  useEffect,
  useReducer,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { getDefaultStore } from 'jotai/vanilla';
import type { Atom } from 'jotai/vanilla';

const use =
  ReactExports.use ||
  (<T>(
    promise: Promise<T> & {
      status?: 'pending' | 'fulfilled' | 'rejected';
      value?: T;
      reason?: unknown;
    },
  ): T => {
    if (promise.status === 'pending') {
      throw promise;
    } else if (promise.status === 'fulfilled') {
      return promise.value as T;
    } else if (promise.status === 'rejected') {
      throw promise.reason;
    } else {
      promise.status = 'pending';
      promise.then(
        (v) => {
          promise.status = 'fulfilled';
          promise.value = v;
        },
        (e) => {
          promise.status = 'rejected';
          promise.reason = e;
        },
      );
      throw promise;
    }
  });

type Displayable = string | number;
type DisplayableAtom = Atom<Displayable | Promise<Displayable>>;
type Store = ReturnType<typeof getDefaultStore>;

type Unsubscribe = () => void;
type Subscribe = (callback: () => void) => Unsubscribe;
type Read = () => Displayable | Promise<Displayable>;

const SIGNAL = Symbol('JOTAI_SIGNAL');
type Signal = {
  [SIGNAL]: { s: Subscribe; r: Read };
};
const isSignal = (x: unknown): x is Signal => !!(x as any)?.[SIGNAL];

const signalCache = new WeakMap<Store, WeakMap<DisplayableAtom, Signal>>();

const getSignal = (store: Store, atom: DisplayableAtom): Signal => {
  let atomSignalCache = signalCache.get(store);
  if (!atomSignalCache) {
    atomSignalCache = new WeakMap();
    signalCache.set(store, atomSignalCache);
  }
  let signal = atomSignalCache.get(atom);
  if (!signal) {
    const subscribe: Subscribe = (callback) => store.sub(atom, callback);
    const read: Read = () => store.get(atom);
    signal = {
      [SIGNAL]: { s: subscribe, r: read },
    };
    atomSignalCache.set(atom, signal);
  }
  return signal;
};

const subscribeSignal = (signal: Signal, callback: () => void) => {
  const { s: subscribe } = signal[SIGNAL];
  return subscribe(callback);
};

const readSignal = (signal: Signal) => {
  const { r: read } = signal[SIGNAL];
  const value = read();
  if (value instanceof Promise) {
    // HACK this could violate the rule of using `use`.
    return use(value);
  }
  return value;
};

export const signal = (
  atom: DisplayableAtom,
  store = getDefaultStore(),
): string => {
  return getSignal(store, atom) as Signal & string; // HACK lie type
};

const useMemoList = <T>(list: T[], compareFn = (a: T, b: T) => a === b) => {
  const [state, setState] = useState(list);
  const listChanged =
    list.length !== state.length ||
    list.some((arg, index) => !compareFn(arg, state[index] as T));
  if (listChanged) {
    // schedule update, triggers re-render
    setState(list);
  }
  return listChanged ? list : state;
};

const Rerenderer = ({
  signals,
  render,
}: {
  signals: Signal[];
  render: () => ReactNode;
}): ReactNode => {
  const [, rerender] = useReducer((c) => c + 1, 0);
  const memoedSignals = useMemoList(signals);
  useEffect(() => {
    const unsubs = memoedSignals.map((sig) => subscribeSignal(sig, rerender));
    return () => unsubs.forEach((unsub) => unsub());
  }, [memoedSignals]);
  return render();
};

const findAllSignals = (x: unknown): Signal[] => {
  if (isSignal(x)) {
    return [x];
  }
  if (Array.isArray(x)) {
    return x.flatMap(findAllSignals);
  }
  if (typeof x === 'object' && x !== null) {
    return Object.values(x).flatMap(findAllSignals);
  }
  return [];
};

const fillAllSignalValues = <T>(x: T): T => {
  if (isSignal(x)) {
    return readSignal(x) as T;
  }
  if (Array.isArray(x)) {
    let changed = false;
    const x2 = x.map((item) => {
      const item2 = fillAllSignalValues(item);
      if (item !== item2) {
        changed = true; // HACK side effect
      }
      return item2;
    });
    return changed ? (x2 as typeof x) : x;
  }
  if (typeof x === 'object' && x !== null) {
    let changed = false;
    const x2 = Object.fromEntries(
      Object.entries(x).map(([key, value]) => {
        const value2 = fillAllSignalValues(value);
        if (value !== value2) {
          changed = true; // HACK side effect
        }
        return [key, value2];
      }),
    );
    return changed ? (x2 as typeof x) : x;
  }
  return x;
};

export const createElement = ((type: any, props?: any, ...children: any[]) => {
  const signalsInChildren = children.flatMap((child) =>
    isSignal(child) ? [child] : [],
  );
  const signalsInProps = findAllSignals(props);
  if (!signalsInChildren.length && !signalsInProps.length) {
    return createElementOrig(type, props, ...children);
  }
  const getChildren = () =>
    signalsInChildren.length
      ? children.map((child) => (isSignal(child) ? readSignal(child) : child))
      : children;
  const getProps = () =>
    signalsInProps.length ? fillAllSignalValues(props) : props;
  return createElementOrig(Rerenderer as any, {
    signals: [...signalsInChildren, ...signalsInProps],
    render: () => createElementOrig(type, getProps(), ...getChildren()),
  });
}) as typeof createElementOrig;
