function getLegalPages(settings) {
    const supportEmail = settings.support_email || "contact@recytech.me";
    const supportAddress = settings.support_address || "Rue Louis-Favre 62, 2017 Boudry";

    return {
        "politique-confidentialite": {
            title: "Politique de confidentialité",
            heading: "Politique de confidentialité",
            intro: "Cette politique décrit les données traitées par la boutique RecyTech, les finalités de traitement et les droits des personnes concernées.",
            sections: [
                {
                    title: "Responsable du traitement",
                    paragraphs: [
                        `Le responsable du traitement des données personnelles collectées via la boutique est RecyTech, joignable à l'adresse ${supportAddress} et par e-mail à ${supportEmail}.`,
                        "Cette politique s'applique aux données traitées lors de la consultation du site, de l'utilisation du panier, de la validation d'une commande et des échanges de support liés à la boutique.",
                    ],
                    bullets: [],
                },
                {
                    title: "Ce que nous collectons et stockons",
                    paragraphs: [
                        "Pendant votre visite et lors d'une commande, nous collectons uniquement les informations nécessaires au fonctionnement de la boutique et à l'exécution du contrat.",
                        "Le site ne propose actuellement pas de compte client. Les avis que vous envoyez sur la boutique sont modérés avant publication. Il ne stocke pas non plus les données complètes de carte bancaire sur ses propres serveurs.",
                    ],
                    bullets: [
                        "le contenu du panier et certaines préférences de commande, au moyen d'une session technique et de cookies strictement nécessaires au fonctionnement du site",
                        "les coordonnées de contact et de commande : nom, e-mail, adresses de facturation et de livraison, téléphone si vous le fournissez, notes de commande",
                        "les détails de commande : produits commandés, mode de livraison, mode de paiement, montant, numéro de commande et statut de paiement",
                        "les avis envoyés sur la boutique : note, nom affiché, titre, message et e-mail si vous le fournissez",
                        "les références techniques transmises par les prestataires de paiement lorsque vous choisissez Stripe, Swiss Bitcoin Pay ou le virement bancaire",
                    ],
                },
                {
                    title: "Pourquoi nous utilisons ces données",
                    paragraphs: [
                        "Nous utilisons ces données pour traiter la commande, organiser la livraison ou le retrait, enregistrer le paiement, émettre une facture ou un récapitulatif de commande, répondre aux demandes de support et respecter nos obligations administratives et comptables.",
                        "Les données de session et de panier servent également à maintenir l'état du panier et à mémoriser temporairement les informations saisies dans le formulaire de commande.",
                    ],
                    bullets: [
                        "traitement et suivi des commandes",
                        "gestion des paiements et prévention des abus ou erreurs de paiement",
                        "organisation de l'expédition ou du retrait",
                        "service client, remboursement et gestion des retours",
                        "respect des obligations légales, fiscales et comptables",
                    ],
                },
                {
                    title: "Partage avec des tiers",
                    paragraphs: [
                        "Nous ne vendons pas vos données personnelles. Nous les communiquons uniquement lorsque cela est nécessaire à l'exploitation de la boutique ou imposé par la loi.",
                        "Selon le mode de paiement choisi, certaines données peuvent être transmises à nos prestataires de paiement, à des prestataires logistiques ou à notre infrastructure d'envoi d'e-mails afin de permettre l'exécution de la commande et le suivi client.",
                    ],
                    bullets: [
                        "prestataires de paiement, notamment Stripe pour le paiement par carte et Swiss Bitcoin Pay pour le paiement bitcoin",
                        "prestataires de livraison ou transporteurs lorsque vous choisissez une expédition",
                        "prestataire SMTP ou infrastructure d'envoi d'e-mails lorsqu'un message relatif à la commande vous est adressé depuis l'administration de la boutique",
                        "autorités ou conseillers lorsque la loi l'exige ou lorsqu'il faut faire valoir ou défendre des droits",
                    ],
                },
                {
                    title: "Cookies et technologies similaires",
                    paragraphs: [
                        "La boutique utilise des cookies et une session technique strictement nécessaires afin de faire fonctionner le panier, conserver temporairement vos informations de commande et sécuriser la navigation.",
                        "À la date de publication de cette politique, la boutique n'utilise pas de cookies publicitaires ni de suivi marketing tiers sur son front principal.",
                    ],
                    bullets: [],
                },
                {
                    title: "Durée de conservation",
                    paragraphs: [
                        "Les données de session et de panier sont conservées temporairement pendant la navigation ou jusqu'à expiration de la session.",
                        "Les informations de commande et de facturation sont conservées aussi longtemps que nécessaire pour le traitement de la commande puis pendant la durée requise par les obligations légales applicables, notamment comptables et fiscales.",
                        "À ce jour, RecyTech prévoit une conservation pouvant aller jusqu'à 10 ans pour les documents et données de commande utiles à la comptabilité et à la défense des droits.",
                    ],
                    bullets: [],
                },
                {
                    title: "Vos droits",
                    paragraphs: [
                        "Conformément au droit suisse applicable, vous pouvez notamment demander l'accès à vos données personnelles, leur rectification et, lorsque les conditions légales sont réunies, leur suppression ou la limitation de certains traitements.",
                        `Pour exercer vos droits ou poser une question relative à la protection des données, contactez RecyTech à ${supportEmail}.`,
                    ],
                    bullets: [
                        "droit d'accès aux données traitées",
                        "droit de rectification des données inexactes",
                        "droit de demander la suppression dans la mesure compatible avec les obligations légales de conservation",
                        "droit d'obtenir des informations sur les destinataires de vos données et, le cas échéant, sur certains transferts à l'étranger",
                    ],
                },
            ],
        },
        "conditions-generales-de-vente": {
            title: "Conditions générales de vente",
            heading: "Conditions générales de vente",
            intro: "Les présentes conditions générales de vente s'appliquent aux ventes effectuées via la boutique RecyTech.",
            sections: [
                {
                    title: "Identité du vendeur et champ d'application",
                    paragraphs: [
                        `Le site shop.recytech.me est exploité par RecyTech, joignable à ${supportAddress} et par e-mail à ${supportEmail}.`,
                        "Les présentes conditions s'appliquent à toute commande passée sur la boutique par un client privé ou professionnel, sauf accord écrit contraire.",
                    ],
                    bullets: [],
                },
                {
                    title: "Produits, disponibilité et informations",
                    paragraphs: [
                        "Les produits proposés sont présentés avec leur dénomination, leur état, leur prix et, lorsque l'information est disponible, leur stock. Les photographies et descriptions ont une valeur informative et ne constituent pas une garantie absolue d'identité parfaite.",
                        "Les produits sont vendus dans la limite des stocks disponibles. En cas d'indisponibilité ou d'erreur manifeste, RecyTech peut contacter l'acheteur afin de proposer une solution appropriée, y compris le remboursement.",
                    ],
                    bullets: [],
                },
                {
                    title: "Commande et conclusion du contrat",
                    paragraphs: [
                        "Le client sélectionne les produits, vérifie son panier, renseigne les informations demandées puis valide sa commande. Le site permet de corriger les erreurs de saisie avant l'envoi final de la commande.",
                        "Après validation, un récapitulatif de commande est affiché et la commande est enregistrée dans le système de la boutique. Le contrat est conclu lorsque RecyTech accepte la commande, notamment par l'enregistrement de celle-ci et, le cas échéant, par l'encaissement ou le traitement du paiement.",
                    ],
                    bullets: [],
                },
                {
                    title: "Prix et paiement",
                    paragraphs: [
                        "Les prix sont indiqués en CHF, sauf mention contraire. Les frais de livraison ou de retrait payants sont affichés avant validation définitive de la commande.",
                        "Le paiement peut être effectué selon les options rendues disponibles sur le site au moment de la commande, en particulier par carte bancaire, bitcoin, virement bancaire ou en espèces lors d'un retrait lorsque cette option est proposée.",
                        "Lorsque le paiement est traité par un prestataire externe, les conditions et contrôles du prestataire concernent également la transaction.",
                    ],
                    bullets: [],
                },
                {
                    title: "Livraison et retrait",
                    paragraphs: [
                        "Les produits sont remis soit par expédition, soit par retrait selon les options proposées au moment de la commande.",
                        "Les délais de livraison ou de mise à disposition sont indicatifs, sauf engagement écrit contraire. L'acheteur doit vérifier l'état apparent du colis et signaler sans délai tout dommage ou toute erreur de livraison.",
                    ],
                    bullets: [],
                },
                {
                    title: "Garantie et réclamations",
                    paragraphs: [
                        "L'acheteur doit signaler les défauts constatés dès que possible après la réception. Les droits légaux en matière de défauts restent réservés dans la mesure du droit applicable.",
                        "Pour les appareils d'occasion ou reconditionnés, RecyTech prévoit une garantie contractuelle de 12 mois, sous réserve des exclusions mentionnées dans la présente politique et des droits légaux impératifs.",
                        "La garantie ne couvre pas les dommages liés à une mauvaise utilisation, à une intervention non autorisée, à l'usure normale ou à une utilisation contraire aux instructions du produit.",
                    ],
                    bullets: [],
                },
                {
                    title: "Retours, remboursements et droit applicable",
                    paragraphs: [
                        "La politique de retours et de remboursements de RecyTech est décrite dans la page dédiée. Sauf engagement commercial contraire de RecyTech, le droit suisse ne prévoit pas de droit général de révocation pour les achats en ligne.",
                        "Les présentes conditions sont soumises au droit suisse. Le for juridique impératif demeure réservé ; à défaut, les tribunaux compétents du canton de Neuchâtel sont compétents.",
                    ],
                    bullets: [],
                },
            ],
        },
        "remboursements-retours": {
            title: "Politique de remboursements et de retours",
            heading: "Politique de remboursements et de retours",
            intro: "Cette politique décrit les conditions commerciales appliquées par RecyTech en matière de retours, d'échanges et de remboursements.",
            sections: [
                {
                    title: "Aperçu",
                    paragraphs: [
                        "RecyTech propose à titre commercial une politique de retour de 30 jours à compter de la réception du produit, sous réserve des conditions ci-dessous.",
                        "Cette politique commerciale complète les droits légaux éventuellement applicables ; elle ne doit pas être comprise comme l'existence d'un droit général de révocation prévu automatiquement par le droit suisse pour tout achat en ligne.",
                    ],
                    bullets: [],
                },
                {
                    title: "Conditions de retour",
                    paragraphs: [
                        "Pour être éligible à un retour standard, l'article doit être restitué dans un état compatible avec une revente ou un contrôle technique raisonnable, avec ses accessoires essentiels et, si possible, son emballage d'origine.",
                        "Le client doit fournir une preuve d'achat ou le numero de commande correspondant.",
                    ],
                    bullets: [
                        "les articles endommagés après la livraison en raison d'une mauvaise utilisation peuvent être refusés",
                        "les retours annoncés après le délai commercial de 30 jours peuvent être refusés hors cas de garantie ou d'obligation légale",
                        "les produits explicitement exclus de reprise au moment de la vente ne sont pas repris, sauf défaut couvert",
                    ],
                },
                {
                    title: "Produits défectueux ou non conformes",
                    paragraphs: [
                        "Si le produit est défectueux, incomplet ou non conforme à la commande, le client doit contacter RecyTech sans délai avec une description du problème et, dans la mesure du possible, des photographies.",
                        "Dans ces cas, RecyTech examinera si une réparation, un remplacement, une réduction de prix ou un remboursement est approprié selon les circonstances et le droit applicable.",
                    ],
                    bullets: [],
                },
                {
                    title: "Frais de retour et remboursement",
                    paragraphs: [
                        "Sauf erreur de RecyTech ou produit défectueux reconnu, les frais de retour sont à la charge du client.",
                        "Une fois le retour reçu et contrôlé, RecyTech informe le client de l'acceptation ou du refus du remboursement. En cas d'acceptation, le remboursement est effectué sur le moyen de paiement approprié ou selon une autre modalité convenue.",
                        "Les frais d'expédition initiaux ne sont remboursés que si la loi l'impose ou si RecyTech en décide autrement dans le cas concret.",
                    ],
                    bullets: [],
                },
                {
                    title: "Échanges et contact",
                    paragraphs: [
                        "Les échanges sont traités au cas par cas selon la disponibilité du stock. Lorsqu'un produit identique n'est plus disponible, RecyTech peut proposer une alternative ou un remboursement.",
                        `Pour toute question relative à un retour, un remboursement ou une garantie, contactez RecyTech à ${supportEmail} ou à l'adresse ${supportAddress}.`,
                    ],
                    bullets: [],
                },
            ],
        },
    };
}

module.exports = { getLegalPages };
