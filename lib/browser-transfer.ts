export async function copyToClipboard(text: string): Promise<boolean> {
    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch {
        // Fall through to execCommand fallback.
    }

    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "true");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    document.body.removeChild(textarea);
    return copied;
}
