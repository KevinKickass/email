export type LoadedImage = { index: number; dataUrl: string };

/** Parent-owned handlers; no sender script runs inside the sandbox. */
export function bindMailFrame(
  document: Document,
  links: string[],
  disabled: boolean,
  open: (url: string) => void,
  preview: (url: string) => void,
) {
  const destinations = new Map<Element, string>();
  for (const anchor of document.querySelectorAll<HTMLAnchorElement>(
    "a[data-mail-link]",
  )) {
    const index = anchor.getAttribute("data-mail-link") ?? "";
    const url = /^\d+$/.test(index) ? links[Number(index)] : undefined;
    anchor.removeAttribute("href");
    if (!url || !/^https?:\/\//i.test(url)) continue;
    anchor.title = url;
    anchor.setAttribute("role", "link");
    anchor.setAttribute("aria-disabled", String(disabled));
    anchor.tabIndex = disabled ? -1 : 0;
    destinations.set(anchor, url);
  }
  function target(event: Event) {
    return (event.target as Element | null)?.closest?.("a[data-mail-link]");
  }
  function activate(event: Event) {
    if ((event as MouseEvent).button > 1) return;
    const anchor = target(event);
    if (!anchor) return;
    event.preventDefault();
    const url = destinations.get(anchor);
    if (!disabled && url) open(url);
  }
  function key(event: KeyboardEvent) {
    if (event.key === "Enter") activate(event);
  }
  function show(event: Event) {
    const anchor = target(event);
    preview(anchor ? (destinations.get(anchor) ?? "") : "");
  }
  function hide() {
    preview("");
  }
  document.addEventListener("click", activate);
  document.addEventListener("auxclick", activate);
  document.addEventListener("keydown", key);
  document.addEventListener("mouseover", show);
  document.addEventListener("focusin", show);
  document.addEventListener("mouseout", hide);
  document.addEventListener("focusout", hide);
  return () => {
    document.removeEventListener("click", activate);
    document.removeEventListener("auxclick", activate);
    document.removeEventListener("keydown", key);
    document.removeEventListener("mouseover", show);
    document.removeEventListener("focusin", show);
    document.removeEventListener("mouseout", hide);
    document.removeEventListener("focusout", hide);
  };
}

export function displayMailImages(document: Document, images: LoadedImage[]) {
  const allowed = new Map(
    images
      .filter((image) =>
        /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(
          image.dataUrl,
        ),
      )
      .map((image) => [String(image.index), image.dataUrl]),
  );
  for (const image of document.querySelectorAll<HTMLImageElement>(
    "img[data-mail-image]",
  )) {
    const data = allowed.get(image.getAttribute("data-mail-image") ?? "");
    if (data) image.src = data;
    else image.removeAttribute("src");
  }
  for (const element of document.querySelectorAll<HTMLElement>(
    "[data-mail-background]",
  )) {
    const data = allowed.get(
      element.getAttribute("data-mail-background") ?? "",
    );
    element.style.backgroundImage = data ? `url("${data}")` : "";
  }
}
