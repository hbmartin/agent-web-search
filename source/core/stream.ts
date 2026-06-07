export class AsyncQueue<T> implements AsyncIterable<T> {
  readonly #items: T[] = [];
  readonly #waiters: ((value: IteratorResult<T>) => void)[] = [];
  #closed = false;

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
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter({ done: true, value: undefined });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.#items.shift();
        if (item !== undefined) {
          return Promise.resolve({ done: false, value: item });
        }

        if (this.#closed) {
          return Promise.resolve({ done: true, value: undefined });
        }

        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}
