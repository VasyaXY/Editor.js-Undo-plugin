export class AsyncQueue {
    constructor() {
        this.tail = Promise.resolve();
    }
    enqueue(operation) {
        const result = this.tail.then(operation);
        this.tail = result.then(() => undefined, () => undefined);
        return result;
    }
}
//# sourceMappingURL=AsyncQueue.js.map