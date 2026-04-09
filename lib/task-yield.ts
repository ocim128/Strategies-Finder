export interface TaskYielder {
    yieldControl(): Promise<void>;
}

export function createTaskYielder(): TaskYielder {
    let channel: MessageChannel | null = null;
    const pendingResolvers: Array<() => void> = [];
    let lastRealYieldAt = 0;

    const getChannel = (): MessageChannel => {
        if (!channel) {
            channel = new MessageChannel();
            channel.port1.onmessage = () => {
                const resolve = pendingResolvers.shift();
                resolve?.();
            };
        }
        return channel;
    };

    const yieldControl = async (): Promise<void> => {
        if (typeof document !== "undefined" && document.hidden) {
            const now = performance.now();
            if (now - lastRealYieldAt < 4_000) return;
            lastRealYieldAt = now;
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
            return;
        }

        const ch = getChannel();
        await new Promise<void>((resolve) => {
            pendingResolvers.push(resolve);
            ch.port2.postMessage(undefined);
        });
    };

    return { yieldControl };
}
