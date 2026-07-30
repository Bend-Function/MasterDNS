export type IntentKey = {
  current: () => string;
  reset: () => void;
};

export function createIntentKey(factory: () => string = () => crypto.randomUUID()): IntentKey {
  let key: string | null = null;

  return {
    current() {
      key ??= factory();
      return key;
    },
    reset() {
      key = null;
    },
  };
}
