export class AsyncQueue {
  private tail: Promise<void> = Promise.resolve();

  public enqueue<Result>(operation: () => Result | Promise<Result>): Promise<Result> {
    const result = this.tail.then(operation);

    this.tail = result.then(
      () => undefined,
      () => undefined
    );

    return result;
  }
}
