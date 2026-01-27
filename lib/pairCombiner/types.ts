import { OHLCVData } from "../strategies/index";
import { Time } from "lightweight-charts";

export type AnalysisMethod = 'copula' | 'wavelet' | 'transferEntropy';

export interface CopulaResult {
    kendallTau: number;
    tailDependence: {
        upper: number;
        lower: number;
    };
    copulaType: 'gaussian' | 'clayton' | 'gumbel';
    opportunityScore: number;
}

export interface WaveletLevel {
    scale: number;
    detail: number[];
    approximation: number[];
    energy: number;
}

export interface WaveletResult {
    levels: WaveletLevel[];
    dominantCycle: number;
    noiseRatio: number;
    smoothedSpread: number[];
    spreadZScore: number;
}

export interface TransferEntropyResult {
    te_1_to_2: number;
    te_2_to_1: number;
    netFlow: number;
    leadingAsset: 'primary' | 'secondary' | 'neutral';
    lagBars: number;
    significance: number;
}

export interface AlignedPairData {
    primary: OHLCVData[];
    secondary: OHLCVData[];
    spread: number[];
    ratio: number[];
    alignedTimestamps: Time[];
}

export interface PairAnalysisResults {
    primarySymbol: string;
    secondarySymbol: string;
    interval: string;
    alignedBars: number;
    correlation: number;
    spreadMean: number;
    spreadStd: number;
    spreadZScore: number;
    ratio: number;
    opportunityScore: number;
    generatedAt: number;
    copula?: CopulaResult;
    wavelet?: WaveletResult;
    transferEntropy?: TransferEntropyResult;
    notes?: string[];
}
