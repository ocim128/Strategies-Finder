import type { OHLCVData } from "./types/strategies";

const OHLCV_BINARY_MAGIC = 0x4F484C56;
const OHLCV_BINARY_VERSION = 1;
const OHLCV_BINARY_FIELD_COUNT = 6;
const OHLCV_BINARY_HEADER_BYTES = 16;

export type BinaryOhlcvRow = {
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
};

export function encodeBinaryOhlcvRows(rows: readonly BinaryOhlcvRow[]): ArrayBuffer {
    const rowCount = rows.length;
    const buffer = new ArrayBuffer(OHLCV_BINARY_HEADER_BYTES + OHLCV_BINARY_FIELD_COUNT * rowCount * Float64Array.BYTES_PER_ELEMENT);
    const view = new DataView(buffer);
    const columnBytes = rowCount * Float64Array.BYTES_PER_ELEMENT;

    view.setUint32(0, OHLCV_BINARY_MAGIC, true);
    view.setUint32(4, OHLCV_BINARY_VERSION, true);
    view.setUint32(8, rowCount, true);
    view.setUint32(12, OHLCV_BINARY_FIELD_COUNT, true);

    for (let i = 0; i < rowCount; i += 1) {
        const row = rows[i]!;
        const offset = OHLCV_BINARY_HEADER_BYTES + i * Float64Array.BYTES_PER_ELEMENT;
        view.setFloat64(offset, row.time, true);
        view.setFloat64(offset + columnBytes, row.open, true);
        view.setFloat64(offset + 2 * columnBytes, row.high, true);
        view.setFloat64(offset + 3 * columnBytes, row.low, true);
        view.setFloat64(offset + 4 * columnBytes, row.close, true);
        view.setFloat64(offset + 5 * columnBytes, row.volume, true);
    }

    return buffer;
}

export function decodeBinaryOhlcvRows(buffer: ArrayBuffer): OHLCVData[] | null {
    if (buffer.byteLength < OHLCV_BINARY_HEADER_BYTES) return null;

    const view = new DataView(buffer);
    const magic = view.getUint32(0, true);
    const version = view.getUint32(4, true);
    const rowCount = view.getUint32(8, true);
    const fieldCount = view.getUint32(12, true);
    const expectedBytes = OHLCV_BINARY_HEADER_BYTES + rowCount * fieldCount * Float64Array.BYTES_PER_ELEMENT;

    if (
        magic !== OHLCV_BINARY_MAGIC
        || version !== OHLCV_BINARY_VERSION
        || fieldCount !== OHLCV_BINARY_FIELD_COUNT
        || buffer.byteLength !== expectedBytes
    ) {
        return null;
    }

    const candles: OHLCVData[] = [];
    const columnBytes = rowCount * Float64Array.BYTES_PER_ELEMENT;
    for (let i = 0; i < rowCount; i += 1) {
        const offset = OHLCV_BINARY_HEADER_BYTES + i * Float64Array.BYTES_PER_ELEMENT;
        const time = view.getFloat64(offset, true);
        const open = view.getFloat64(offset + columnBytes, true);
        const high = view.getFloat64(offset + 2 * columnBytes, true);
        const low = view.getFloat64(offset + 3 * columnBytes, true);
        const close = view.getFloat64(offset + 4 * columnBytes, true);
        const volume = view.getFloat64(offset + 5 * columnBytes, true);
        if (!Number.isFinite(time) || !Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) {
            return null;
        }
        candles.push({
            time: time as OHLCVData["time"],
            open,
            high,
            low,
            close,
            volume: Number.isFinite(volume) ? volume : 0,
        });
    }
    return candles;
}
