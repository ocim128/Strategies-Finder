export function ensureLazyStylesheet(id: string, href: string): void {
    if (typeof document === "undefined") {
        return;
    }
    if (document.getElementById(id)) {
        return;
    }

    const link = document.createElement("link");
    link.id = id;
    link.rel = "stylesheet";
    link.href = href;
    document.head.appendChild(link);
}
