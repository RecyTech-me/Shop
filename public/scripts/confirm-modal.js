export function initConfirmModal() {
    const confirmModal = document.querySelector("[data-confirm-modal]");
    const confirmModalTitle = confirmModal?.querySelector("[data-confirm-title]");
    const confirmModalMessage = confirmModal?.querySelector("[data-confirm-message]");
    const confirmModalSubmit = confirmModal?.querySelector("[data-confirm-submit]");
    const confirmModalCancel = confirmModal?.querySelector("[data-confirm-cancel]");
    let pendingConfirmForm = null;

    function closeConfirmModal() {
        if (!confirmModal) {
            return;
        }

        confirmModal.hidden = true;
        document.body.classList.remove("modal-open");
        pendingConfirmForm = null;
    }

    if (confirmModal && confirmModalTitle && confirmModalMessage && confirmModalSubmit) {
        document.querySelectorAll("[data-confirm-form]").forEach((form) => {
            form.addEventListener("submit", (event) => {
                event.preventDefault();
                pendingConfirmForm = form;
                confirmModalTitle.textContent = form.dataset.confirmTitle || "Confirmer l'action";
                confirmModalMessage.textContent = form.dataset.confirmMessage || "Cette action est irréversible.";
                confirmModalSubmit.textContent = form.dataset.confirmSubmit || "Confirmer";
                confirmModal.hidden = false;
                document.body.classList.add("modal-open");
            });
        });

        confirmModal.addEventListener("click", (event) => {
            if (event.target.hasAttribute("data-confirm-close")) {
                closeConfirmModal();
            }
        });

        confirmModalCancel?.addEventListener("click", closeConfirmModal);

        confirmModalSubmit.addEventListener("click", () => {
            if (!pendingConfirmForm) {
                closeConfirmModal();
                return;
            }

            const form = pendingConfirmForm;
            closeConfirmModal();
            form.submit();
        });

        document.addEventListener("keydown", (event) => {
            if (event.key === "Escape" && !confirmModal.hidden) {
                closeConfirmModal();
            }
        });
    }
}
