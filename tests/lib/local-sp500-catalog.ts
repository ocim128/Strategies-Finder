import {
    getLocalDailyAssets,
    searchLocalDailyAssets,
    type LocalDailyAsset,
} from "./local-daily-datasets";

export interface LocalSp500Asset {
    symbol: string;
    name: string;
    sector: string;
}

function toLocalSp500Asset(asset: LocalDailyAsset): LocalSp500Asset {
    return {
        symbol: asset.symbol,
        name: asset.name,
        sector: asset.sector ?? "",
    };
}

export async function getLocalSp500Assets(): Promise<LocalSp500Asset[]> {
    const assets = await getLocalDailyAssets("sp500");
    return assets.map(toLocalSp500Asset);
}

export async function searchLocalSp500Assets(query: string, limit = 50): Promise<LocalSp500Asset[]> {
    const assets = await searchLocalDailyAssets(query, limit, "sp500");
    return assets.map(toLocalSp500Asset);
}
