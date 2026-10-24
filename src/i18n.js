// -----------------------------------------------------------------------------
// Runtime texts shown in Gladys. Every text is a { en, fr } object. They never
// quote a text of the system, a secret nor the user name: only our own words,
// error codes, the address, and the serial number and software of the system
// (checked by pattern).
// -----------------------------------------------------------------------------

const seconds = (ms) => Math.max(1, Math.round(ms / 1000));
const minutes = (ms) => Math.max(1, Math.round(ms / 60_000));
const hours = (ms) => Math.max(1, Math.round(ms / 3_600_000));
export const delay = (ms) => {
  if (ms >= 2 * 3_600_000) return { en: `${hours(ms)} h`, fr: `${hours(ms)} h` };
  if (ms >= 60_000) return { en: `${minutes(ms)} min`, fr: `${minutes(ms)} min` };
  return { en: `${seconds(ms)} s`, fr: `${seconds(ms)} s` };
};

/** "18:02:05 UTC": an instant, never in the local time of a container. */
export const clock = (at) => `${new Date(at).toISOString().slice(11, 19)} UTC`;

/** Our words for an error code of src/e3dc/client.js. */
const REASON = {
  unreachable: { en: 'unreachable', fr: 'injoignable' },
  timeout: { en: 'no answer in time', fr: 'pas de réponse à temps' },
  closed: { en: 'connection closed by the system', fr: 'connexion fermée par le système' },
  protocol: {
    en: 'answer that is not RSCP (is it the right address?)',
    fr: 'réponse qui n’est pas du RSCP (est-ce la bonne adresse ?)',
  },
  refused: { en: 'log-in refused', fr: 'connexion refusée' },
  login_lost: {
    en: 'no readable answer to the log-in: a wrong RSCP password, or the system was restarting',
    fr: 'pas de réponse lisible à la connexion : mauvais mot de passe RSCP, ou système en redémarrage',
  },
  busy: { en: 'a read is already running', fr: 'une lecture est déjà en cours' },
  aborted: { en: 'read stopped', fr: 'lecture arrêtée' },
};

export function reason(err) {
  return REASON[err?.code] ?? { en: 'unexpected error', fr: 'erreur inattendue' };
}

const INDEX = {
  pv: { en: 'solar production index', fr: 'index de production solaire' },
};

const kwh = (value) => Math.round(value * 1000) / 1000;

const sentences = (lang, list) => list.map((n) => n[lang]).join(' ');
const both = (list) => ({ en: sentences('en', list), fr: sentences('fr', list) });

const heldLine = ({ name, direction, from, to }) =>
  direction === 'down'
    ? {
        en: `${INDEX[name].en}: dropped from ${kwh(from)} to ${kwh(to)} kWh, held back (the last accepted value is sent again). A drop is never accepted: it corrects itself once the index is back above ${kwh(from)} kWh, only the energy above it is counted.`,
        fr: `${INDEX[name].fr} : baisse de ${kwh(from)} à ${kwh(to)} kWh, retenue (la dernière valeur acceptée est renvoyée). Une baisse n’est jamais acceptée : elle se corrige seule quand l’index repasse au-dessus de ${kwh(from)} kWh, seule l’énergie au-dessus est comptée.`,
      }
    : {
        en: `${INDEX[name].en}: jumped from ${kwh(from)} to ${kwh(to)} kWh, held back (not sent to the energy monitoring).`,
        fr: `${INDEX[name].fr} : saut de ${kwh(from)} à ${kwh(to)} kWh, retenu (non envoyé au suivi énergétique).`,
      };

/** Where the RSCP settings are on the display of the system. */
const WHERE = {
  en: 'on the display of the system: Main menu, Personalize, User profile',
  fr: 'sur l’écran du système : menu principal, Personnaliser, Profil utilisateur',
};

export const T = {
  problem: {
    address_missing: {
      en: 'Enter the IP address of the E3/DC system, the user name and password of your E3/DC account and the RSCP password in the configuration.',
      fr: 'Saisissez l’adresse IP du système E3/DC, l’identifiant et le mot de passe de votre compte E3/DC et le mot de passe RSCP dans la configuration.',
    },
    address_invalid: {
      en: 'The address is not valid: enter an IP address or a host name, with an optional port (e.g. 192.168.1.50).',
      fr: 'L’adresse n’est pas valide : saisissez une adresse IP ou un nom d’hôte, avec un port éventuel (ex. 192.168.1.50).',
    },
    username_missing: {
      en: 'Enter the user name of your E3/DC account (the one of the E3/DC portal).',
      fr: 'Saisissez l’identifiant de votre compte E3/DC (celui du portail E3/DC).',
    },
    username_invalid: {
      en: 'The user name is not valid (at most 256 characters, no control character).',
      fr: 'L’identifiant n’est pas valide (256 caractères au plus, sans caractère de contrôle).',
    },
    password_missing: {
      en: 'Enter the password of your E3/DC account.',
      fr: 'Saisissez le mot de passe de votre compte E3/DC.',
    },
    password_invalid: {
      en: 'The password is not valid (at most 256 characters, no control character).',
      fr: 'Le mot de passe n’est pas valide (256 caractères au plus, sans caractère de contrôle).',
    },
    key_missing: {
      en: `Enter the RSCP password, set ${WHERE.en}.`,
      fr: `Saisissez le mot de passe RSCP, défini ${WHERE.fr}.`,
    },
    key_invalid: {
      en: `The RSCP password is too long (32 bytes at most, no control character): set a shorter one ${WHERE.en}.`,
      fr: `Le mot de passe RSCP est trop long (32 octets au plus, sans caractère de contrôle) : choisissez-en un plus court ${WHERE.fr}.`,
    },
  },
  connecting: {
    en: 'Reading the E3/DC system…',
    fr: 'Lecture du système E3/DC…',
  },
  /** Not read yet in this start: the next read. */
  waiting: (at) => ({
    en: `E3/DC: next read at ${clock(at)}.`,
    fr: `E3/DC : prochaine lecture à ${clock(at)}.`,
  }),
  refused: (address, code) =>
    code === 'refused'
      ? {
          en: `${address} refuses the log-in: check the user name and password of your E3/DC account, then save the configuration again. Reads stopped until then (the "Test the connection" button tries once).`,
          fr: `${address} refuse la connexion : vérifiez l’identifiant et le mot de passe de votre compte E3/DC, puis enregistrez de nouveau la configuration. Lectures arrêtées d’ici là (le bouton « Tester la connexion » fait un essai).`,
        }
      : {
          en: `${address} gives no readable answer to the log-in, twice in a row: the RSCP password most likely does not match the one set ${WHERE.en}, or it is not the E3/DC system at this address (check its address in your router), or the system was restarting. Correct it (or wait for the end of the restart) and save the configuration again. Reads stopped until then (the "Test the connection" button tries once).`,
          fr: `${address} ne donne pas de réponse lisible à la connexion, deux fois de suite : le mot de passe RSCP ne correspond sans doute pas à celui défini ${WHERE.fr}, ou ce n’est pas le système E3/DC à cette adresse (vérifiez son adresse dans votre box), ou le système redémarrait. Corrigez-le (ou attendez la fin du redémarrage) puis enregistrez de nouveau la configuration. Lectures arrêtées d’ici là (le bouton « Tester la connexion » fait un essai).`,
        },
  failing: (address, err, wait) => ({
    en: `${address} could not be read (${reason(err).en}): new try in ${delay(wait).en}.`,
    fr: `${address} n’a pas pu être lu (${reason(err).fr}) : nouvel essai dans ${delay(wait).fr}.`,
  }),
  ok: (serial, firmware, notes = []) =>
    both([
      {
        en: `E3/DC system ${serial} answering${firmware ? ` (software ${firmware})` : ''}.`,
        fr: `Le système E3/DC ${serial} répond${firmware ? ` (logiciel ${firmware})` : ''}.`,
      },
      ...notes,
    ]),
  notes: {
    noDevice: {
      en: 'Create its device from the "Discover" tab to receive its values.',
      fr: 'Créez son appareil depuis l’onglet « Découverte » pour recevoir ses valeurs.',
    },
    noSerial: {
      en: 'The system did not give a readable serial number this time: nothing published (its values are only sent to the device of its serial number).',
      fr: 'Le système n’a pas donné de numéro de série lisible cette fois : rien n’est publié (ses valeurs ne vont qu’à l’appareil de son numéro de série).',
    },
    dayMissing: {
      en: 'The energies of the day were not read this time; the other values are up to date.',
      fr: 'Les énergies du jour n’ont pas été lues cette fois ; les autres valeurs sont à jour.',
    },
    noIndex: (names) => ({
      en: `The ${names.map((n) => INDEX[n].en).join(', ')} was not updated this time: the counter of the day did not follow (a jump, a drop away from midnight, or a clock set back). Nothing is counted meanwhile; it goes on by itself at the next new day at the latest.`,
      fr: `L’${names.map((n) => INDEX[n].fr).join(', ')} n’a pas été mis à jour cette fois : le compteur du jour n’a pas suivi (un saut, une baisse loin de minuit, ou une horloge reculée). Rien n’est compté entre-temps ; il reprend seul au plus tard au jour suivant.`,
    }),
    timeZone: (zone) => ({
      en: `The time zone of the form is unknown: the day starts at midnight ${zone}.`,
      fr: `Le fuseau horaire du formulaire est inconnu : la journée commence à minuit ${zone}.`,
    }),
    held: (held) =>
      both([
        ...held.map(heldLine),
        ...(held.some((h) => h.direction === 'up')
          ? [
              {
                en: 'If a jump is right, click "Accept the held index" twice in the configuration of the integration (the first click lists, the second accepts exactly what was listed). Saving the configuration accepts nothing.',
                fr: 'Si un saut est juste, cliquez deux fois sur « Accepter l’index retenu » dans la configuration de l’intégration (le premier clic liste, le second accepte exactement ce qui a été listé). Enregistrer la configuration n’accepte rien.',
              },
            ]
          : []),
      ]),
  },
  accept: {
    nothing: {
      en: 'No index is held back: nothing to accept.',
      fr: 'Aucun index n’est retenu : rien à accepter.',
    },
    /** Only drops held: never accepted (as gladys-imeon 0.1.2), they correct themselves. */
    drop: (names) => ({
      en: `The index held back (${names.map((n) => INDEX[n].en).join(', ')}) is a drop: it is never accepted, it corrects itself once the index is back above the last accepted value. Nothing to accept.`,
      fr: `L’index retenu (${names.map((n) => INDEX[n].fr).join(', ')}) est une baisse : elle n’est jamais acceptée, l’index se corrige seul quand il repasse au-dessus de la dernière valeur acceptée. Rien à accepter.`,
    }),
    confirm: (held, within) =>
      both([
        {
          en: 'A second click accepts exactly these values:',
          fr: 'Un second clic accepte exactement ces valeurs :',
        },
        ...held.map((h) => ({
          en: `${INDEX[h.name].en}: ${kwh(h.from)} → ${kwh(h.to)} kWh (${kwh(h.to - h.from)} kWh counted at once).`,
          fr: `${INDEX[h.name].fr} : ${kwh(h.from)} → ${kwh(h.to)} kWh (${kwh(h.to - h.from)} kWh comptés d’un coup).`,
        })),
        {
          en: `Click "Accept the held index" again, after a few seconds and within ${delay(within).en}, to accept them; accept only if this energy was real.`,
          fr: `Cliquez de nouveau sur « Accepter l’index retenu », après quelques secondes et dans les ${delay(within).fr}, pour les accepter ; n’acceptez que si cette énergie est réelle.`,
        },
      ]),
    done: (accepted, changed) =>
      both([
        ...accepted.map((h) => ({
          en: `Accepted: ${INDEX[h.name].en} ${kwh(h.to)} kWh, sent at the next read.`,
          fr: `Accepté : ${INDEX[h.name].fr} ${kwh(h.to)} kWh, envoyé à la prochaine lecture.`,
        })),
        ...(changed.length > 0
          ? [
              {
                en: `Not accepted, the value changed since the first click: ${changed.map((h) => INDEX[h.name].en).join('; ')}. Click again to list it.`,
                fr: `Non accepté, la valeur a changé depuis le premier clic : ${changed.map((h) => INDEX[h.name].fr).join(' ; ')}. Cliquez de nouveau pour la lister.`,
              },
            ]
          : []),
        { en: 'A different value stays held.', fr: 'Une autre valeur reste retenue.' },
      ]),
  },
  test: {
    /** The values of the last read, in short. */
    ok: (address, serial, values, firmware) => {
      const en = [];
      const fr = [];
      if (values.soc !== undefined) {
        en.push(`charge ${values.soc} %`);
        fr.push(`charge ${values.soc} %`);
      }
      if (values.pvPower !== undefined) {
        en.push(`solar ${Math.round(values.pvPower)} W`);
        fr.push(`solaire ${Math.round(values.pvPower)} W`);
      }
      if (values.housePower !== undefined) {
        en.push(`house ${Math.round(values.housePower)} W`);
        fr.push(`maison ${Math.round(values.housePower)} W`);
      }
      const soft = firmware
        ? { en: `, software ${firmware}`, fr: `, logiciel ${firmware}` }
        : { en: '', fr: '' };
      return {
        en: `${address}: E3/DC system ${serial ?? '?'}, log-in accepted${soft.en}${en.length ? ` (${en.join(', ')})` : ''}.`,
        fr: `${address} : système E3/DC ${serial ?? '?'}, connexion acceptée${soft.fr}${fr.length ? ` (${fr.join(', ')})` : ''}.`,
      };
    },
    failed: (address, err) => ({
      en: `${address}: ${reason(err).en}.`,
      fr: `${address} : ${reason(err).fr}.`,
    }),
    /** The button never reads sooner than the pace: what is known, and when the next read can be. */
    notNow: (at) => ({
      en: `Not asked now (never faster than the reading interval): next read possible at ${clock(at)}.`,
      fr: `Non interrogé maintenant (jamais plus vite que l’intervalle de lecture) : prochaine lecture possible à ${clock(at)}.`,
    }),
    lastRead: (at) => ({
      en: `Last read at ${clock(at)}.`,
      fr: `Dernière lecture à ${clock(at)}.`,
    }),
    slow: {
      en: 'The system is slow to answer: look at the integration status in a minute.',
      fr: 'Le système tarde à répondre : regardez l’état de l’intégration dans une minute.',
    },
    lines: (lines) => both(lines),
  },
};
