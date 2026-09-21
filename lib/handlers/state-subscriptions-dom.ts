export const CHART_MODE_IDS = {
  toggle: 'chartModeToggle',
  label: 'chartModeLabel',
} as const;

export function getChartModeToggle(): HTMLElement | null {
  return document.getElementById(CHART_MODE_IDS.toggle);
}

export function getChartModeLabel(): HTMLElement | null {
  return document.getElementById(CHART_MODE_IDS.label);
}

export const EXECUTION_MODEL_SELECT_ID = 'executionModel';

export const STATE_SUBSCRIPTIONS_REQUIRED_IDS = [
  ...Object.values(CHART_MODE_IDS),
  EXECUTION_MODEL_SELECT_ID,
] as const;

function getTypedElement<T extends HTMLElement>(
  id: string,
  constructor: { new(): T }
): T | null {
  const el = document.getElementById(id);
  return el instanceof constructor ? el : null;
}

export function getExecutionModelSelect(): HTMLSelectElement | null {
  return getTypedElement(EXECUTION_MODEL_SELECT_ID, HTMLSelectElement);
}

export function createStateSubscriptionsDom() {
  return {
    chartModeToggle: getChartModeToggle(),
    chartModeLabel: getChartModeLabel(),
    executionModelSelect: getExecutionModelSelect(),
  };
}

export type StateSubscriptionsDom = ReturnType<typeof createStateSubscriptionsDom>;
