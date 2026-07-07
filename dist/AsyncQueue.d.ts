export declare class AsyncQueue {
    private tail;
    enqueue<Result>(operation: () => Result | Promise<Result>): Promise<Result>;
}
//# sourceMappingURL=AsyncQueue.d.ts.map