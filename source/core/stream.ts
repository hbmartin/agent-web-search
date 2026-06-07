export class AsyncQueue<T> implements AsyncIterable<T> {
  readonly #items: T[] = [];
  readonly #waiters: ((value: IteratorResult<T>) => void)[] = [];
  readonly #onCancel?: () => void;
  #closed = false;
  #cancelled = false;

  constructor(onCancel?: () => void) {
    this.#onCancel = onCancel;
  }

  push(item: T): void {
    if (this.#closed) {
      return;
    }

    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter({ done: false, value: item });
      return;
    }

    this.#items.push(item);
  }

  close(): void {
    if (this.#closed) {
      return;
    }

    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter({ done: true, value: undefined });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.#items.length > 0) {
          const item = this.#items.shift() as T;
          return Promise.resolve({ done: false, value: item });
        }

        if (this.#closed) {
          return Promise.resolve({ done: true, value: undefined });
        }

        return new Promise((resolve) => this.#waiters.push(resolve));
      },
      return: () => {
        this.close();
        this.cancel();
        return Promise.resolve({ done: true, value: undefined });
      },
    };
  }

  private cancel(): void {
    if (this.#cancelled) {
      return;
    }

    this.#cancelled = true;
    this.#onCancel?.();
  }
}
