"use strict";

// Debug logging toggle (stored in chrome.storage.sync as 'debugLog')
let DEBUG_LOG = false;
getOrInitProperty("debugLog", false).then((v) => {
  DEBUG_LOG = !!v;
  if (DEBUG_LOG) console.log("[Debug] debugLog enabled");
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (
    area === "sync" &&
    Object.prototype.hasOwnProperty.call(changes, "debugLog")
  ) {
    DEBUG_LOG = !!changes.debugLog.newValue;
    console.log(`[Debug] debugLog ${DEBUG_LOG ? "enabled" : "disabled"}`);
  }
});

function checkAnkiConnection() {
  checkConnection()
    .then(() => {
      console.log("AnkiConnection UP");
      chrome.storage.sync.set(
        { ankiConnectionStatus: { ok: true, date: "now" } },
        function () {}
      );
    })
    .catch(() => {
      console.log("AnkiConnection DOWN");
      chrome.storage.sync.set(
        { ankiConnectionStatus: { ok: false, date: "now" } },
        function () {}
      );
    });
  setTimeout(checkAnkiConnection, 10_000);
}

checkAnkiConnection();

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action !== "addNotes") {
    return true;
  }

  getOrInitProperty("ankiConnectionStatus", { ok: false })
    .then((ankiConnectionStatus) => {
      if (!ankiConnectionStatus.ok) {
        sendResponse({
          addedNotes: -1,
          totalNotes: -1,
          error: "Anki is not reachable",
        });
        return Promise.reject();
      }
    })
    .then((t) => {
      const deckName = request.deckName;
      const modelName = request.modelName;
      const tagString = request.tagString;
      const notes = request.learnedItems.map((item) => ({
        deckName: deckName,
        modelName: modelName,
        fields: {
          Word: item.learnLanguageText,
          Picture:
            item.image && item.image.id
              ? `<img src='https://images.babbel.com/v1.0.0/images/${item.image.id}/variations/square/resolutions/500x500.png'/>`
              : "",
          "Extra Info": item.displayLanguageText,
        },
        options: {
          allowDuplicate: false,
          duplicateScope: "deck",
        },
        tags: tagString ? tagString.split(",").map((s) => s.trim()) : [],
        audio:
          item.sound && item.sound.id
            ? [
                {
                  url: `https://sounds.babbel.com/v1.0.0/sounds/${item.sound.id}/normal.mp3`,
                  filename: `${item.sound.id}.mp3`,
                  fields: ["Pronunciation"],
                },
              ]
            : [],
      }));
      if (DEBUG_LOG) {
        console.log("[Babbel2Anki] Prepared notes:", notes.length, {
          deckName,
          modelName,
          tags: tagString,
        });
      }
      createDeck(deckName)
        .then(() => createModel(modelName))
        .then(() => canAddNotes(notes))
        .then((canResp) => {
          const mask = canResp && canResp.result;
          if (!Array.isArray(mask)) {
            if (DEBUG_LOG) console.warn("[AnkiConnect] Unexpected canAddNotes response:", canResp);
            return {
              notesIds: [],
              addedNotes: 0,
              totalNotes: notes.length,
              duplicates: 0,
              error: (canResp && canResp.error) || "Unexpected canAddNotes response",
            };
          }
          const notesToAdd = notes.filter((_, i) => mask[i]);
          const duplicates = mask.filter((v) => !v).length;
          if (DEBUG_LOG) {
            console.log("[Babbel2Anki] Filtered notes:", {
              total: notes.length,
              toAdd: notesToAdd.length,
              duplicates,
            });
          }
          if (notesToAdd.length === 0) {
            return {
              notesIds: [],
              addedNotes: 0,
              totalNotes: notes.length,
              duplicates,
              error: null,
            };
          }
          return addNotes(notesToAdd).then((addResp) => {
            const result = addResp && addResp.result;
            if (Array.isArray(result)) {
              return {
                notesIds: result,
                addedNotes: result.filter((e) => e != null).length,
                totalNotes: notes.length,
                duplicates,
                error: addResp.error,
              };
            }
            if (DEBUG_LOG) {
              console.warn("[AnkiConnect] Unexpected addNotes response:", addResp);
            }
            return {
              notesIds: [],
              addedNotes: 0,
              totalNotes: notes.length,
              duplicates,
              error: (addResp && addResp.error) || "Unexpected AnkiConnect response",
            };
          });
        })
        .then((result) => showNotification(result))
        .then((result) => sendResponse(result));
    });

  return true;
});

function createDeck(deckName) {
  return callAnkiConnect("createDeck", {
    deck: deckName,
  });
}

function createModel(modelName) {
  return callAnkiConnect("createModel", {
    modelName: modelName,
    inOrderFields: ["Word", "Picture", "Extra Info", "Pronunciation"],
    css: `
          .card {
            font-family: arial;
            font-size: 20px;
            text-align: center;
            color: black;
            background-color: white;
          }

          .card1 { background-color: #FFFFFF; }
          .card2 { background-color: #FFFFFF; }`,
    cardTemplates: [
      {
        Name: "Comprehension Card",
        Front: `
{{Word}}<br>
{{Pronunciation}}
          `,
        Back: `
{{Word}}<br>
{{Pronunciation}}
<hr id=answer>
{{Picture}} <br>
<span style="color:grey">{{Extra Info}}</span>
          `,
      },
      {
        Name: "Production Card",
        Front: `
{{Picture}}
{{Extra Info}} <br>
          `,
        Back: `
{{Picture}}
{{Extra Info}} <br>
<hr id=answer>
{{Word}}
<br>
{{Pronunciation}}
          
          `,
      },
    ],
  });
}

function checkConnection() {
  return fetch("http://127.0.0.1:8765", {
    method: "POST",
    body: JSON.stringify({ action: "version", version: 6 }),
  });
}

function addNotes(notes) {
  // console.log("addNotes", notes.length)
  return callAnkiConnect("addNotes", { notes: notes });
}

function canAddNotes(notes) {
  return callAnkiConnect("canAddNotes", { notes: notes });
}

async function callAnkiConnect(action, params = {}, version = 6) {
  const payload = { action, version, params };
  if (DEBUG_LOG) {
    console.log("[AnkiConnect] Request:", payload);
  }
  const response = await fetch("http://127.0.0.1:8765", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  let data;
  try {
    data = await response.json();
  } catch (e) {
    data = { result: null, error: `Invalid JSON from AnkiConnect: ${e}` };
  }
  if (DEBUG_LOG) {
    console.log("[AnkiConnect] Response:", data);
  }
  return data;
}

function showNotification(result) {
  const hasError = !!result.error;
  const icon = chrome.runtime && chrome.runtime.getURL
    ? chrome.runtime.getURL("images/icon.png")
    : "images/icon.png";
  const options = {
    title: hasError
      ? "Failed to add words"
      : `Added ${result.addedNotes} new words`,
    message: hasError
      ? String(result.error)
      : `\nTotal words: ${result.totalNotes}` +
        (typeof result.duplicates === "number"
          ? `\nDuplicates skipped: ${result.duplicates}`
          : ""),
    iconUrl: icon,
    type: "basic",
  };
  chrome.notifications.create("", options);
  if (DEBUG_LOG) {
    console.log("[Babbel2Anki] Notification:", options);
  }
  return result;
}

function getOrInitProperty(property, defaultValue) {
  return new Promise((resolve) => {
    chrome.storage.sync.get([property], (result) => {
      if (result[property] === undefined || result[property] == null) {
        result[property] = defaultValue;
        chrome.storage.sync.set({ [property]: defaultValue }, () =>
          console.log(
            `initiated property ${property} with value ${defaultValue}`
          )
        );
      }
      resolve(result[property]);
    });
  });
}
