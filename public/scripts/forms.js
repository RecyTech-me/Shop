import { csrfToken } from "./shared.js";

export function initForms() {
    if (csrfToken) {
        document.querySelectorAll('form[method="post"]').forEach((form) => {
            let hiddenField = form.querySelector('input[name="_csrf"]');

            if (!hiddenField) {
                hiddenField = document.createElement("input");
                hiddenField.type = "hidden";
                hiddenField.name = "_csrf";
                form.append(hiddenField);
            }

            hiddenField.value = csrfToken;
        });
    }

    document.querySelectorAll(".flash").forEach((flash) => {
        window.setTimeout(() => {
            flash.classList.add("flash-hidden");
            window.setTimeout(() => {
                flash.parentElement?.classList.add("flash-shell-hidden");
            }, 220);
        }, 5000);
    });
}
