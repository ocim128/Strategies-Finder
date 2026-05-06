export const CHART_MANAGER_IDS = {
    mainChart: "main-chart",
    equityChart: "equity-chart",
} as const;

export const CHART_MANAGER_REQUIRED_IDS = Object.values(CHART_MANAGER_IDS);

export function createChartManagerDom(doc: Document = document) {
    return {
        mainChartContainer: doc.getElementById(CHART_MANAGER_IDS.mainChart),
        equityChartContainer: doc.getElementById(CHART_MANAGER_IDS.equityChart),
    };
}
