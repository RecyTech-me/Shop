export function initProductGalleries() {
    document.querySelectorAll("[data-product-gallery]").forEach((gallery) => {
        const track = gallery.querySelector("[data-product-gallery-track]");
        const slides = [...gallery.querySelectorAll("[data-gallery-slide]")];
        const thumbs = [...gallery.querySelectorAll("[data-gallery-image]")];
        const previousButton = gallery.querySelector("[data-gallery-prev]");
        const nextButton = gallery.querySelector("[data-gallery-next]");

        if (!track || !thumbs.length) {
            return;
        }

        const totalSlides = thumbs.length;
        let currentIndex = Math.max(thumbs.findIndex((thumb) => thumb.classList.contains("is-active")), 0);
        let visualIndex = totalSlides > 1 ? currentIndex + 1 : currentIndex;
        let isTransitioning = false;
        let transitionFallbackTimer = 0;

        function updateThumbs(index) {
            thumbs.forEach((thumb, thumbIndex) => {
                thumb.classList.toggle("is-active", thumbIndex === index);
            });
        }

        function updateSlides(index) {
            slides.forEach((slide) => {
                const logicalIndex = Number(slide.dataset.galleryLogicalIndex || 0);
                slide.setAttribute("aria-hidden", String(logicalIndex !== index));
            });
        }

        function applyTrackPosition(animate = true) {
            track.classList.toggle("is-no-transition", !animate);
            track.style.transform = `translateX(-${visualIndex * 100}%)`;
        }

        function finishTransition() {
            clearTimeout(transitionFallbackTimer);

            if (visualIndex === 0) {
                visualIndex = totalSlides;
                applyTrackPosition(false);
                track.getBoundingClientRect();
            } else if (visualIndex === totalSlides + 1) {
                visualIndex = 1;
                applyTrackPosition(false);
                track.getBoundingClientRect();
            }

            isTransitioning = false;
        }

        function syncGallery(index, direction = "next") {
            const safeIndex = ((index % totalSlides) + totalSlides) % totalSlides;
            const activeThumb = thumbs[safeIndex];

            if (!activeThumb || isTransitioning || safeIndex === currentIndex) {
                return;
            }

            isTransitioning = true;
            currentIndex = safeIndex;
            updateThumbs(currentIndex);
            updateSlides(currentIndex);

            if (direction === "next" && safeIndex === 0 && totalSlides > 1) {
                visualIndex = totalSlides + 1;
            } else if (direction === "prev" && safeIndex === totalSlides - 1 && totalSlides > 1) {
                visualIndex = 0;
            } else {
                visualIndex = safeIndex + (totalSlides > 1 ? 1 : 0);
            }

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

        thumbs.forEach((thumb, index) => {
            thumb.addEventListener("click", () => {
                const direction = index < currentIndex ? "prev" : "next";
                syncGallery(index, direction);
            });
        });

        previousButton?.addEventListener("click", () => {
            syncGallery(currentIndex - 1, "prev");
        });

        nextButton?.addEventListener("click", () => {
            syncGallery(currentIndex + 1, "next");
        });

        gallery.addEventListener("keydown", (event) => {
            if (event.key === "ArrowLeft") {
                event.preventDefault();
                syncGallery(currentIndex - 1, "prev");
            }

            if (event.key === "ArrowRight") {
                event.preventDefault();
                syncGallery(currentIndex + 1, "next");
            }
        });
    });
}
