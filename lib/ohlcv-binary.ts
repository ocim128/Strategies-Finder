import type { OHLCVData } from "./types/strategies";

const OHLCV_BINARY_MAGIC = 0x4F484C56;
const OHLCV_BINARY_VERSION = 1;
const OHLCV_BINARY_FIELD_COUNT = 6;
const OHLCV_BINARY_HEADER_BYTES = 16;
const FLOAT64_BYTES = Float64Array.BYTES_PER_ELEMENT;
const IS_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

type BinaryOhlcvInput = ArrayBuffer | ArrayBufferView;

export type BinaryOhlcvRow = {
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
};

function getInputBuffer(input: BinaryOhlcvInput): { buffer: ArrayBufferLike; byteOffset: number; byteLength: number } {
    return ArrayBuffer.isView(input)
        ? { buffer: input.buffer, byteOffset: input.byteOffset, byteLength: input.byteLength }
        : { buffer: input, byteOffset: 0, byteLength: input.byteLength };
}

export function encodeBinaryOhlcvRows(rows: readonly BinaryOhlcvRow[]): ArrayBuffer {
    const rowCount = rows.length;
    const buffer = new ArrayBuffer(OHLCV_BINARY_HEADER_BYTES + OHLCV_BINARY_FIELD_COUNT * rowCount * FLOAT64_BYTES);
    const view = new DataView(buffer);
    const columnBytes = rowCount * FLOAT64_BYTES;

    view.setUint32(0, OHLCV_BINARY_MAGIC, true);
    view.setUint32(4, OHLCV_BINARY_VERSION, true);
    view.setUint32(8, rowCount, true);
    view.setUint32(12, OHLCV_BINARY_FIELD_COUNT, true);

    if (IS_LITTLE_ENDIAN) {
        const times = new Float64Array(buffer, OHLCV_BINARY_HEADER_BYTES, rowCount);
        const opens = new Float64Array(buffer, OHLCV_BINARY_HEADER_BYTES + columnBytes, rowCount);
        const highs = new Float64Array(buffer, OHLCV_BINARY_HEADER_BYTES + 2 * columnBytes, rowCount);
        const lows = new Float64Array(buffer, OHLCV_BINARY_HEADER_BYTES + 3 * columnBytes, rowCount);
        const closes = new Float64Array(buffer, OHLCV_BINARY_HEADER_BYTES + 4 * columnBytes, rowCount);
        const volumes = new Float64Array(buffer, OHLCV_BINARY_HEADER_BYTES + 5 * columnBytes, rowCount);
        for (let i = 0; i < rowCount; i += 1) {
            const row = rows[i]!;
            times[i] = row.time;
            opens[i] = row.open;
            highs[i] = row.high;
            lows[i] = row.low;
            closes[i] = row.close;
            volumes[i] = row.volume;
        }
        return buffer;
    }

    for (let i = 0; i < rowCount; i += 1) {
        const row = rows[i]!;
        const offset = OHLCV_BINARY_HEADER_BYTES + i * FLOAT64_BYTES;
        view.setFloat64(offset, row.time, true);
        view.setFloat64(offset + columnBytes, row.open, true);
        view.setFloat64(offset + 2 * columnBytes, row.high, true);
        view.setFloat64(offset + 3 * columnBytes, row.low, true);
        view.setFloat64(offset + 4 * columnBytes, row.close, true);
        view.setFloat64(offset + 5 * columnBytes, row.volume, true);
    }

    return buffer;
}

export function decodeBinaryOhlcvRows(input: BinaryOhlcvInput): OHLCVData[] | null {
    const binary = getInputBuffer(input);
    if (binary.byteLength < OHLCV_BINARY_HEADER_BYTES) return null;

    const view = new DataView(binary.buffer, binary.byteOffset, binary.byteLength);
    const magic = view.getUint32(0, true);
    const version = view.getUint32(4, true);
    const rowCount = view.getUint32(8, true);
    const fieldCount = view.getUint32(12, true);
    const expectedBytes = OHLCV_BINARY_HEADER_BYTES + rowCount * fieldCount * FLOAT64_BYTES;

    if (
        magic !== OHLCV_BINARY_MAGIC
        || version !== OHLCV_BINARY_VERSION
        || fieldCount !== OHLCV_BINARY_FIELD_COUNT
        || binary.byteLength !== expectedBytes
    ) {
        return null;
    }

    const candles: OHLCVData[] = [];
    const columnBytes = rowCount * FLOAT64_BYTES;
    const columnStartByteOffset = binary.byteOffset + OHLCV_BINARY_HEADER_BYTES;
    if (IS_LITTLE_ENDIAN && columnStartByteOffset % FLOAT64_BYTES === 0) {
        const times = new Float64Array(binary.buffer, columnStartByteOffset, rowCount);
        const opens = new Float64Array(binary.buffer, columnStartByteOffset + columnBytes, rowCount);
        const highs = new Float64Array(binary.buffer, columnStartByteOffset + 2 * columnBytes, rowCount);
        const lows = new Float64Array(binary.buffer, columnStartByteOffset + 3 * columnBytes, rowCount);
        const closes = new Float64Array(binary.buffer, columnStartByteOffset + 4 * columnBytes, rowCount);
        const volumes = new Float64Array(binary.buffer, columnStartByteOffset + 5 * columnBytes, rowCount);
        for (let i = 0; i < rowCount; i += 1) {
            const time = times[i]!;
            const open = opens[i]!;
            const high = highs[i]!;
            const low = lows[i]!;
            const close = closes[i]!;
            const volume = volumes[i]!;
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

    for (let i = 0; i < rowCount; i += 1) {
        const offset = OHLCV_BINARY_HEADER_BYTES + i * FLOAT64_BYTES;
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
