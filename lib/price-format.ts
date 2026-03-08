export function formatDisplayPrice(price: number | null | undefined): string {
    if (price === null || price === undefined || !Number.isFinite(price)) {
        return "-";
    }

    const absPrice = Math.abs(price);
    if (absPrice === 0) {
        return "0";
    }

    let decimals: number;
    if (absPrice >= 1000) {
        decimals = 2;
    } else if (absPrice >= 1) {
        decimals = 4;
    } else {
        decimals = Math.min(12, Math.max(6, Math.floor(-Math.log10(absPrice)) + 4));
    }

    return trimTrailingZeros(price.toFixed(decimals));
}

function trimTrailingZeros(value: string): string {
    if (!value.includes(".")) {
        return value;
    }

    return value
        .replace(/(\.\d*?[1-9])0+$/, "$1")
        .replace(/\.0+$/, "")
        .replace(/\.$/, "");
}
