export function initProductGalleries() {
    document.querySelectorAll("[data-product-gallery]").forEach((gallery) => {
        const track = gallery.querySelector("[data-product-gallery-track]");
        const viewport = gallery.querySelector("[data-gallery-viewport]");
        const main = gallery.querySelector(".product-gallery-main");
        const fallback = gallery.querySelector("[data-gallery-fallback]");
        const thumbsContainer = gallery.querySelector("[data-gallery-thumbs]");
        const previousButton = gallery.querySelector("[data-gallery-prev]");
        const nextButton = gallery.querySelector("[data-gallery-next]");
        const productName = gallery.dataset.galleryProductName || "ce produit";

        if (!track || !viewport) {
            return;
        }

        let items = [...gallery.querySelectorAll("[data-gallery-slide]")].map((slide) => {
            const id = slide.dataset.galleryId;
            return {
                id,
                slide,
                thumb: gallery.querySelector(`[data-gallery-image][data-gallery-id="${id}"]`),
            };
        });
        let currentIndex = Math.max(items.findIndex((item) => item.thumb?.classList.contains("is-active")), 0);
        let isTransitioning = false;
        let transitionFallbackTimer = 0;
        let swipeStart = null;

        function updateThumbs(index) {
            items.forEach((item, itemIndex) => {
                item.thumb?.classList.toggle("is-active", itemIndex === index);
                item.thumb?.setAttribute("aria-label", `Voir l'image ${itemIndex + 1} sur ${items.length} de ${productName}`);
            });
        }

        function updateSlides(index) {
            items.forEach((item, itemIndex) => {
                item.slide.setAttribute("aria-hidden", String(itemIndex !== index));
            });
        }

        function applyTrackPosition(animate = true) {
            track.classList.toggle("is-no-transition", !animate);
            track.style.transform = `translateX(-${currentIndex * 100}%)`;
        }

        function finishTransition() {
            clearTimeout(transitionFallbackTimer);
            isTransitioning = false;
        }

        function updateControls() {
            const hasMultipleImages = items.length > 1;

            if (previousButton) {
                previousButton.hidden = !hasMultipleImages;
            }
            if (nextButton) {
                nextButton.hidden = !hasMultipleImages;
            }
            if (thumbsContainer) {
                thumbsContainer.hidden = !hasMultipleImages;
            }
        }

        function showFallback() {
            viewport.hidden = true;
            if (fallback) {
                fallback.hidden = false;
            }
            main?.classList.add("is-empty");
            updateControls();
        }

        function removeFailedImage(id) {
            const failedIndex = items.findIndex((item) => item.id === id);

            if (failedIndex === -1) {
                return;
            }

            const [failedItem] = items.splice(failedIndex, 1);
            failedItem.slide.remove();
            failedItem.thumb?.remove();
            clearTimeout(transitionFallbackTimer);
            isTransitioning = false;

            if (!items.length) {
                currentIndex = 0;
                showFallback();
                return;
            }

            if (failedIndex < currentIndex || currentIndex >= items.length) {
                currentIndex = Math.max(0, currentIndex - 1);
            }

            updateThumbs(currentIndex);
            updateSlides(currentIndex);
            updateControls();
            applyTrackPosition(false);
        }

        function syncGallery(index) {
            if (items.length < 2 || isTransitioning) {
                return;
            }

            const safeIndex = ((index % items.length) + items.length) % items.length;

            if (safeIndex === currentIndex) {
                return;
            }

            isTransitioning = true;
            currentIndex = safeIndex;
            updateThumbs(currentIndex);
            updateSlides(currentIndex);

            requestAnimationFrame(() => {
                applyTrackPosition(true);
            });

            transitionFallbackTimer = setTimeout(finishTransition, 420);
        }

        track.addEventListener("transitionend", (event) => {
            if (event.target !== track || event.propertyName !== "transform" || !isTransitioning) {
                return;
            }

            finishTransition();
        });

        applyTrackPosition(false);
        requestAnimationFrame(() => {
            track.classList.remove("is-no-transition");
        });
        updateThumbs(currentIndex);
        updateSlides(currentIndex);
        updateControls();

        [...items].forEach((item) => {
            [item.slide.querySelector("img"), item.thumb?.querySelector("img")].filter(Boolean).forEach((image) => {
                const applyFailure = () => removeFailedImage(item.id);
                image.addEventListener("error", applyFailure, { once: true });
                if (image.complete && image.naturalWidth === 0) {
                    applyFailure();
                }
            });

            item.thumb?.addEventListener("click", () => {
                const index = items.findIndex((candidate) => candidate.id === item.id);
                if (index !== -1) {
                    syncGallery(index);
                }
            });
        });

        previousButton?.addEventListener("click", () => {
            syncGallery(currentIndex - 1);
        });

        nextButton?.addEventListener("click", () => {
            syncGallery(currentIndex + 1);
        });

        viewport.addEventListener("pointerdown", (event) => {
            if (event.pointerType !== "touch" || items.length < 2) {
                return;
            }

            swipeStart = {
                pointerId: event.pointerId,
                x: event.clientX,
                y: event.clientY,
            };

            try {
                viewport.setPointerCapture(event.pointerId);
            } catch {
                // Synthetic pointer events and older browsers may not support capture.
            }
        });

        viewport.addEventListener("pointerup", (event) => {
            if (!swipeStart || event.pointerId !== swipeStart.pointerId) {
                return;
            }

            const deltaX = event.clientX - swipeStart.x;
            const deltaY = event.clientY - swipeStart.y;
            const swipeThreshold = Math.max(40, viewport.clientWidth * 0.12);
            swipeStart = null;

            if (Math.abs(deltaX) < swipeThreshold || Math.abs(deltaX) <= Math.abs(deltaY) * 1.25) {
                return;
            }

            syncGallery(currentIndex + (deltaX < 0 ? 1 : -1));
        });

        viewport.addEventListener("pointercancel", () => {
            swipeStart = null;
        });

        gallery.addEventListener("keydown", (event) => {
            if (event.key === "ArrowLeft") {
                event.preventDefault();
                syncGallery(currentIndex - 1);
            }

            if (event.key === "ArrowRight") {
                event.preventDefault();
                syncGallery(currentIndex + 1);
            }
        });
    });
}
