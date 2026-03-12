import type { EnsembleLabDom } from "./feature-dom-contracts";

type ContextWithTrades = {
    tradeSamples: unknown[];
};

export interface StrategyEnsembleRenderHost<TContext extends ContextWithTrades> {
    resetResultPanels(): void;
    renderSummary(context: TContext): void;
    renderCurrentContext(context: TContext): void;
    renderBuilder(context: TContext): void;
    renderHistoricalOdds(context: TContext): void;
    renderContribution(context: TContext): void;
    renderReplacement(context: TContext): void;
    renderRadar(context: TContext): void;
    card(label: string, value: string): string;
}

export function renderStrategyEnsembleResults<TContext extends ContextWithTrades>(
    host: StrategyEnsembleRenderHost<TContext>,
    dom: EnsembleLabDom,
    context: TContext
): void {
    const hasTrades = context.tradeSamples.length > 0;

    dom.ensembleResults.style.display = hasTrades ? "" : "none";
    dom.ensembleCurrentContextSection.style.display = hasTrades ? "" : "none";
    dom.ensembleBuilderSection.style.display = hasTrades ? "" : "none";
    dom.ensembleHistoricalOddsSection.style.display = hasTrades ? "" : "none";
    dom.ensembleDiagnosticsSection.style.display = hasTrades ? "" : "none";
    dom.ensembleContributionSection.style.display = hasTrades ? "" : "none";
    dom.ensembleReplacementSection.style.display = hasTrades ? "" : "none";
    dom.ensembleRadarSection.style.display = hasTrades ? "" : "none";

    if (!hasTrades) {
        host.resetResultPanels();
        dom.ensembleResults.style.display = "";
        dom.ensembleSummary.innerHTML = host.card("Status", "No target trades found");
        return;
    }

    host.renderSummary(context);
    host.renderCurrentContext(context);
    host.renderBuilder(context);
    host.renderHistoricalOdds(context);
    host.renderContribution(context);
    host.renderReplacement(context);
    host.renderRadar(context);
}
