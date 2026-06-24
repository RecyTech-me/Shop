export function initImageFallbacks() {
    document.querySelectorAll("[data-image-fallback]").forEach((image) => {
        const applyFallback = () => {
            const fallback = image.nextElementSibling;
            const fallbackClass = image.dataset.fallbackClass;

            image.hidden = true;
            if (fallback) {
                fallback.hidden = false;
            }
            if (fallbackClass) {
                image.parentElement?.classList.add(fallbackClass);
            }
        };

        image.addEventListener("error", applyFallback, { once: true });
        if (image.complete && image.naturalWidth === 0) {
            applyFallback();
        }
    });
}
