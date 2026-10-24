# E3/DC

Intégration **non officielle**, sans lien avec E3/DC (HagerEnergy). Elle lit
votre **système de stockage E3/DC** (S10 E, S10 E Pro, S10 X, S10 Mini,
Quattroporte…) sur votre réseau local, par **RSCP**, le protocole local du
système, sans cloud : le portail E3/DC n'est jamais contacté.

**Jamais testé avec un vrai appareil** : l'intégration a été écrite à partir
de la bibliothèque [pye3dc](https://github.com/fsantini/python-e3dc) (MIT),
sans système E3/DC sous la main. Vos retours sont les bienvenus.

## Lecture seule

L'intégration **ne fait que lire**. Elle ne change jamais un réglage, ne lance
ni n'arrête jamais une charge, une décharge ou une wallbox, et n'envoie aucune
requête qui modifie quoi que ce soit (son code n'en connaît aucune).

## Avant de commencer

Sur l'écran du système : **menu principal → Personnaliser → Profil utilisateur
→ mot de passe RSCP**. Définissez un mot de passe RSCP (32 octets au plus, soit 32 caractères sans accent).
Il protège les trames échangées sur votre réseau : sans lui, le système ne
répond pas.

Il vous faut aussi **l'identifiant et le mot de passe de votre compte E3/DC**
(ceux du portail et de l'application E3/DC) : le système les vérifie lui-même,
sur votre réseau.

Donnez au système une adresse fixe dans votre box (réservation DHCP).

## Configuration

| Champ                        | À saisir                                                                                                                    |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Adresse du système           | Son adresse IP, ex. `192.168.1.50` (port 5033 sauf si vous en ajoutez un autre).                                            |
| Identifiant du compte E3/DC  | L'identifiant du portail et de l'application. Jamais écrit dans les journaux ni affiché dans un état.                       |
| Mot de passe du compte E3/DC | Gardé par Gladys dans sa base, jamais réaffiché, envoyé seulement au système sur votre réseau.                              |
| Mot de passe RSCP            | Celui défini sur l'écran. Gardé par Gladys dans sa base, jamais réaffiché, jamais envoyé : il protège seulement les trames. |
| Production solaire           | « Suivi énergétique » (par défaut) ou « Capteur seulement » (voir plus bas).                                                |
| Fuseau horaire               | Où la journée des énergies du jour commence à minuit. Europe/Berlin par défaut.                                             |
| Intervalle de lecture        | 30 s par défaut, de 30 à 300 s.                                                                                             |

Cliquez ensuite sur **Tester la connexion** : le système est lu une fois
(jamais plus vite que l'intervalle) et son numéro de série s'affiche avec
quelques valeurs.

## Ce que vous obtenez

Un appareil par système, nommé d'après son numéro de série (« E3/DC
S10-… ») ; créez-le depuis l'onglet **Découverte**. Ses fonctions :

- état de charge (%) ;
- puissance de la batterie (W, **signée comme le système la donne** : selon
  pye3dc, positive en charge, négative en décharge) ;
- puissance solaire (W), et l'**index de production solaire** pour le suivi
  énergétique de Gladys (avec sa production par 30 minutes, calculée par
  Gladys) ;
- consommation de la maison (W) ;
- puissance réseau (W, **signée comme le système la donne** : selon pye3dc,
  positive quand elle est prélevée sur le réseau, négative quand elle y est
  injectée) ;
- puissance d'une source additionnelle (W, un onduleur externe, signée telle
  que lue) ;
- autarcie et autoconsommation (%) ;
- puissance de la wallbox, totale et solaire (W), en lecture seule ;
- les énergies du jour (kWh, depuis minuit) : production solaire, charge et
  décharge de la batterie, prélevé sur le réseau et injecté, consommation de
  la maison.

Les signes des puissances de la batterie et du réseau ne sont pas confirmés
sur un vrai système : chacune est une seule valeur signée, telle que lue,
jamais séparée.

## Suivi énergétique

- Le système ne donne son énergie solaire que sous forme de **compteur du
  jour** (sa base de données, depuis minuit). L'intégration en construit un
  index cumulé (le compteur de chaque jour ajouté aux jours terminés), le
  vérifie par une garde, et l'envoie comme index de production solaire. Tout
  doute compte **moins**, jamais plus : un saut ou une baisse du compteur loin
  de minuit n'est pas compté (l'état le dit) ; ce que le système produit entre
  la dernière lecture avant minuit et minuit n'est pas compté.
- Un saut ou une baisse de l'index construit est **retenu** : la dernière
  valeur acceptée est renvoyée et l'état l'affiche. Un **saut**, s'il est
  juste, s'accepte en cliquant deux fois sur **Accepter l'index retenu** (le
  premier clic liste, le second accepte exactement ce qui a été listé). Une
  **baisse n'est jamais acceptée** : elle se corrige seule quand l'index
  repasse au-dessus de la dernière valeur acceptée, et seule l'énergie
  au-dessus est comptée. Enregistrer la configuration n'accepte rien.
- **Pas de double comptage** : la consommation de la maison et l'énergie
  prélevée sur le réseau sont déjà comptées par votre compteur principal
  (Linky…) ; l'intégration les affiche comme de simples valeurs, jamais comme
  un index. L'énergie injectée n'est jamais comptée comme une consommation.
- **« Capteur seulement »** : à choisir si une autre intégration envoie déjà
  cette production solaire à Gladys (sinon elle serait comptée deux fois). À
  choisir avant de créer l'appareil. En revenant plus tard au « Suivi
  énergétique », la première valeur est retenue (deux clics pour l'accepter).

## Erreurs et pauses

- **Connexion refusée** (identifiant ou mot de passe), ou **pas de réponse
  lisible à la connexion deux fois de suite** (le plus souvent un mauvais mot
  de passe RSCP ; le second essai vient 15 minutes après le premier, pour
  qu'un système qui redémarre n'arrête pas les lectures) : les lectures
  **s'arrêtent**, même après un redémarrage,
  jusqu'à ce que vous corrigiez la configuration et l'enregistriez.
  L'intégration ne réessaie jamais seule ; le bouton **Tester la connexion**
  fait un essai par clic (jamais plus vite que l'intervalle).
- **Injoignable** : nouvel essai après l'intervalle de lecture (1 minute au
  moins), puis après le double, et ainsi de suite jusqu'à 15 minutes (ou
  l'intervalle, s'il est plus long).
- **Énergies du jour non lues** : seules elles manquent ; l'état le dit.
- **Un autre numéro de série à l'adresse** : son propre appareil apparaît dans
  la Découverte ; les valeurs ne vont jamais à l'appareil d'un autre numéro
  de série.
- Une seule connexion à la fois, jamais une lecture plus rapide que
  l'intervalle (reconnexion, enregistrement d'un formulaire inchangé,
  redémarrage, bouton de test) ; seuls une nouvelle adresse ou de nouveaux
  identifiants, enregistrés par vous, sont lus tout de suite.

## Confidentialité

Rien ne sort de votre réseau. L'identifiant, le mot de passe et le mot de
passe RSCP ne sont jamais écrits dans les journaux, dans les données de
l'intégration ni dans un état. Tant qu'une connexion est refusée, les données
de l'intégration gardent seulement une empreinte de 8 bits de ce qui a été
refusé (pour savoir, après un redémarrage, si la configuration a changé) ;
elle ne permet de confirmer aucun mot de passe et s'efface à la connexion
réussie suivante.
