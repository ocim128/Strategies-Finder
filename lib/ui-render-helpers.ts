import { escapeHtml } from "./html-escape";

export interface LabeledCardOptions {
    label: string;
    value: string;
    cardClass: string;
    labelClass: string;
    valueClass: string;
    toneClass?: string;
    extraClass?: string;
    escape?: boolean;
}

export function renderLabeledCard(options: LabeledCardOptions): string {
    const {
        label,
        value,
        cardClass,
        labelClass,
        valueClass,
        toneClass = "",
        extraClass = "",
        escape = true,
    } = options;
    const classes = [cardClass, extraClass].filter(Boolean).join(" ");
    const valueClasses = [valueClass, toneClass].filter(Boolean).join(" ");
    const displayLabel = escape ? escapeHtml(label) : label;
    const displayValue = escape ? escapeHtml(value) : value;
    return `
        <div class="${classes}">
            <div class="${labelClass}">${displayLabel}</div>
            <div class="${valueClasses}">${displayValue}</div>
        </div>
    `;
}

export function renderEmptyTableRow(colspan: number, message: string): string {
    return `
        <tr class="table-empty-row">
            <td colspan="${colspan}">${escapeHtml(message)}</td>
        </tr>
    `;
}
