import ReconnectingWebSocket from "/vendor/reconnecting-websocket.js";

const state = {
  config: null,
  roomId: location.pathname.match(/^\/room\/([A-Za-z0-9_-]+)$/)?.[1] || null,
  joinToken: new URLSearchParams(location.hash.slice(1)).get("join"),
  widgets: {},
  room: null,
  countdown: null
};

const elements = Object.fromEntries(
  ["landing", "join", "room", "missing", "create-form", "create-button", "create-error", "join-form", "join-button", "join-error", "name", "room-title", "room-subtitle", "lobby", "game", "invite-url", "copy-invite", "copy-status", "people", "people-count", "cli-command", "copy-cli", "cli-status", "prompt-total", "start-game", "start-error", "prompt-card", "round-label", "timer", "prompt-text", "answer-title", "vote-progress", "answer-options", "vote-status", "reveal-summary", "round-results", "next-prompt", "final-recap", "recap-grid", "score-podium"]
    .map((id) => [id, document.getElementById(id)])
);

boot().catch(() => showError("create-error", "Could not connect to the server."));

async function boot() {
  state.config = await api("/api/config");
  if (!state.roomId) {
    show("landing");
    setupTurnstile("create", "create_room");
    return;
  }

  const inviteKey = `wsd-invite:${state.roomId}`;
  if (state.joinToken) sessionStorage.setItem(inviteKey, state.joinToken);
  else state.joinToken = sessionStorage.getItem(inviteKey);

  const existingRoom = await api(`/api/rooms/${state.roomId}`, {}, true);
  if (existingRoom.ok) {
    showRoom(await existingRoom.json());
    return;
  }
  if (!state.joinToken) return show("missing");
  show("join");
  setupTurnstile("join", "join_room");
}

elements["create-form"].addEventListener("submit", async (event) => {
  event.preventDefault();
  setBusy("create", true);
  showError("create-error", "");
  try {
    const result = await api("/api/rooms", {
      method: "POST",
      body: JSON.stringify({ turnstileToken: tokenFor("create") })
    });
    location.assign(result.joinUrl);
  } catch (error) {
    showError("create-error", error.message);
    resetTurnstile("create");
    setBusy("create", false);
  }
});

elements["join-form"].addEventListener("submit", async (event) => {
  event.preventDefault();
  setBusy("join", true);
  showError("join-error", "");
  try {
    await api(`/api/rooms/${state.roomId}/join`, {
      method: "POST",
      body: JSON.stringify({
        name: elements.name.value,
        joinToken: state.joinToken,
        turnstileToken: tokenFor("join")
      })
    });
    history.replaceState({}, "", `/room/${state.roomId}`);
    showRoom(await api(`/api/rooms/${state.roomId}`));
  } catch (error) {
    showError("join-error", error.message);
    resetTurnstile("join");
    setBusy("join", false);
  }
});

elements["copy-invite"].addEventListener("click", async () => {
  await navigator.clipboard.writeText(elements["invite-url"].value);
  elements["copy-status"].textContent = "Invite copied.";
  setTimeout(() => { elements["copy-status"].textContent = ""; }, 1800);
});

elements["copy-cli"].addEventListener("click", async () => {
  await navigator.clipboard.writeText(elements["cli-command"].textContent);
  elements["cli-status"].textContent = "Command copied. Its import token expires in 30 minutes and works once.";
});

elements["start-game"].addEventListener("click", () => advanceGame("start"));
elements["next-prompt"].addEventListener("click", () => advanceGame("next"));

elements["answer-options"].addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-participant-id]");
  if (!button || state.room?.game.phase !== "voting" || state.room.game.yourVoteId) return;
  for (const option of elements["answer-options"].querySelectorAll("button")) option.disabled = true;
  elements["vote-status"].textContent = "Locking in your vote…";
  try {
    await api(`/api/rooms/${state.roomId}/vote`, {
      method: "POST",
      body: JSON.stringify({ participantId: Number(button.dataset.participantId) })
    });
    if (state.room?.game.phase === "voting") {
      button.classList.add("selected");
      elements["vote-status"].textContent = "Vote locked. Waiting for the room…";
    }
  } catch (error) {
    elements["vote-status"].textContent = error.message;
  }
});

function setupTurnstile(kind, action) {
  if (state.config.turnstileBypass) {
    state.widgets[kind] = "development-bypass";
    setBusy(kind, false);
    return;
  }
  waitForTurnstile(() => {
    state.widgets[kind] = window.turnstile.render(`#${kind}-turnstile`, {
      sitekey: state.config.turnstileSiteKey,
      action,
      appearance: "interaction-only",
      callback: () => setBusy(kind, false),
      "expired-callback": () => setBusy(kind, true),
      "error-callback": () => showError(`${kind}-error`, "Verification could not load. Please retry.")
    });
  });
}

function tokenFor(kind) {
  return state.config.turnstileBypass ? "development-bypass" : window.turnstile.getResponse(state.widgets[kind]);
}

function resetTurnstile(kind) {
  if (!state.config.turnstileBypass && state.widgets[kind] !== undefined) window.turnstile.reset(state.widgets[kind]);
}

function waitForTurnstile(callback) {
  if (window.turnstile) callback();
  else setTimeout(() => waitForTurnstile(callback), 50);
}

function showRoom(room) {
  show("room");
  const token = sessionStorage.getItem(`wsd-invite:${room.id}`);
  const invite = token ? `${location.origin}/room/${room.id}#join=${token}` : "Private invite unavailable after this tab is closed.";
  elements["invite-url"].value = invite;
  elements["copy-invite"].disabled = !token;
  renderRoom(room);
  prepareImportCommand(room.id);
  connectRoomSocket(room.id);
}

async function prepareImportCommand(roomId) {
  try {
    const result = await api(`/api/rooms/${roomId}/import-token`, { method: "POST", body: "{}" });
    elements["cli-command"].textContent = result.command;
    elements["copy-cli"].disabled = false;
  } catch (error) {
    elements["cli-command"].textContent = "Could not create an import command.";
    elements["cli-status"].textContent = error.message;
  }
}

function connectRoomSocket(roomId) {
  state.socket?.close();
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new ReconnectingWebSocket(`${protocol}//${location.host}/api/rooms/${roomId}/socket`, [], {
    minReconnectionDelay: 1_000,
    maxReconnectionDelay: 10_000,
    reconnectionDelayGrowFactor: 1.5,
    connectionTimeout: 5_000,
    maxEnqueuedMessages: 0
  });
  state.socket = socket;
  socket.addEventListener("message", (event) => {
    try {
      const message = JSON.parse(event.data);
      if (message.type === "room_state") renderRoom(message.room);
    } catch {
      socket.close(1003, "invalid_message");
    }
  });
  socket.addEventListener("close", (event) => {
    if (event.code === 1008 && event.reason === "connection_limit") {
      socket.close();
      return;
    }
  });
}

function renderPeople(room) {
  const participantCount = room.participants.length;
  elements["people-count"].textContent = `(${participantCount} participant${participantCount === 1 ? "" : "s"})`;
  elements.people.replaceChildren(...room.participants.map((person) => {
    const item = document.createElement("li");
    item.dataset.initial = person.name.slice(0, 1).toUpperCase();
    item.append(document.createTextNode(person.name));
    if (person.id === room.you.id) {
      const you = document.createElement("small");
      you.className = "you-label";
      you.textContent = "(you)";
      item.append(you);
    }
    if (person.promptCount > 0) {
      const imported = document.createElement("small");
      imported.className = "prompt-imported";
      imported.textContent = "✓ Prompts imported";
      item.append(imported);
    }
    return item;
  }));
}

function renderRoom(room) {
  const previousPhase = state.room?.game.phase;
  state.room = room;
  if (previousPhase && previousPhase !== room.game.phase) {
    requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: "smooth" }));
  }
  renderPeople(room);
  const game = room.game;
  const inLobby = game.phase === "lobby";
  elements.lobby.hidden = !inLobby;
  elements.game.hidden = inLobby;

  if (inLobby) {
    stopCountdown();
    elements["room-title"].textContent = "Get everyone ready.";
    elements["room-subtitle"].textContent = "Share the invite, then bring your funniest prompts from the CLI.";
    elements["prompt-total"].textContent = room.totalPrompts
      ? `Participants added ${room.totalPrompts} prompt${room.totalPrompts === 1 ? "" : "s"}.`
      : "Waiting for the first prompts.";
    elements["start-game"].disabled = !game.canStart;
    return;
  }

  elements["room-title"].textContent = game.phase === "finished" ? "Game over." : "Who said dis?";
  elements["room-subtitle"].textContent = game.phase === "finished"
    ? `${game.round} prompt${game.round === 1 ? "" : "s"} played.`
    : "Choose who you think wrote the prompt.";

  if (game.phase === "finished") {
    const yourPlace = game.standings.findIndex((person) => person.id === room.you.id) + 1;
    stopCountdown();
    elements["prompt-card"].hidden = true;
    elements["answer-title"].textContent = "Final scores";
    elements["vote-progress"].textContent = "";
    elements["answer-options"].replaceChildren();
    elements["vote-status"].textContent = "";
    elements["reveal-summary"].hidden = false;
    elements["reveal-summary"].className = `reveal-summary ${room.you.score === 0 ? "wrong" : "correct"}`;
    elements["reveal-summary"].textContent = `Your final score is ${room.you.score} point${room.you.score === 1 ? "" : "s"}. You are ${formatPlace(yourPlace).toLowerCase()}!`;
    renderScorePodium(game.standings.slice(0, 3));
    elements["round-results"].className = "round-results final-scoreboard";
    elements["round-results"].replaceChildren(...game.standings.slice(3).map((person, offset) => {
      const index = offset + 3;
      const item = document.createElement("li");
      item.className = `standing${person.id === room.you.id ? " is-you" : ""}`;
      const rank = document.createElement("span");
      rank.className = "score-rank";
      rank.textContent = formatPlace(index + 1);
      const player = document.createElement("strong");
      player.textContent = person.name;
      const score = document.createElement("span");
      score.className = "score-value";
      score.textContent = `${person.score} pt${person.score === 1 ? "" : "s"}`;
      item.append(rank, player, score);
      return item;
    }));
    elements["round-results"].hidden = game.standings.length <= 3;
    renderFinalRecap(game.recap || []);
    elements["next-prompt"].hidden = true;
    return;
  }

  elements["final-recap"].hidden = true;
  elements["score-podium"].hidden = true;
  elements["round-results"].className = "round-results";
  elements["prompt-card"].hidden = false;
  elements["round-label"].textContent = `Round ${game.round}`;
  elements["prompt-text"].textContent = game.prompt.text;
  elements["vote-progress"].textContent = `${game.voteCount}/${game.participantCount} voted`;
  renderAnswers(game);
  if (game.phase === "voting") startCountdown(game.deadline);
  else stopCountdown();
}

function renderScorePodium(people) {
  const podium = elements["score-podium"];
  podium.className = `score-podium players-${people.length}`;
  podium.replaceChildren(...people.map((person, index) => {
    const placeLabel = formatPlace(index + 1);
    const isYou = person.id === state.room.you.id;
    const place = document.createElement("article");
    place.className = `podium-place rank-${index + 1}${isYou ? " is-you" : ""}`;
    place.setAttribute("aria-label", `${placeLabel}: ${person.name}${isYou ? ", you" : ""}, ${person.score} points`);
    const details = document.createElement("div");
    details.className = "podium-details";
    const name = document.createElement("strong");
    name.textContent = person.name;
    const score = document.createElement("span");
    score.textContent = `${person.score} point${person.score === 1 ? "" : "s"}`;
    details.append(name, score);
    const base = document.createElement("div");
    base.className = "podium-base";
    const rank = document.createElement("span");
    rank.textContent = placeLabel;
    base.append(rank);
    place.append(details, base);
    return place;
  }));
  podium.hidden = false;
}

function formatPlace(position) {
  const lastTwoDigits = position % 100;
  const suffix = lastTwoDigits >= 11 && lastTwoDigits <= 13
    ? "th"
    : ({ 1: "st", 2: "nd", 3: "rd" }[position % 10] || "th");
  return `${position}${suffix} Place`;
}

function renderFinalRecap(rounds) {
  elements["recap-grid"].replaceChildren(...rounds.map((round) => {
    const authoredByYou = round.author.id === state.room.you.id;
    const tile = document.createElement("article");
    tile.className = `recap-tile${authoredByYou ? " authored-by-you" : ""}`;
    const meta = document.createElement("div");
    meta.className = "recap-meta";
    const number = document.createElement("span");
    number.textContent = `Round ${round.round}`;
    meta.append(number);
    const prompt = document.createElement("blockquote");
    prompt.textContent = round.prompt;
    const guessesLabel = document.createElement("p");
    guessesLabel.className = "recap-guesses-label";
    guessesLabel.textContent = "I think this was prompted by...";
    const guesses = document.createElement("ul");
    guesses.className = "recap-guesses";
    guesses.replaceChildren(...round.options.map((option) => {
      const votersForOption = round.results.filter((result) => result.guessParticipantId === option.id);
      const isCorrect = option.id === round.author.id;
      const item = document.createElement("li");
      item.className = `response-group${isCorrect ? " correct" : ""}`;
      const choice = document.createElement("div");
      choice.className = "response-choice";
      const answer = document.createElement("strong");
      answer.textContent = option.name;
      const count = document.createElement("span");
      count.className = "response-count";
      count.textContent = `${votersForOption.length} vote${votersForOption.length === 1 ? "" : "s"}`;
      choice.append(answer);
      if (isCorrect) {
        const correct = document.createElement("span");
        correct.className = "correct-answer-label";
        correct.textContent = "✓ Correct answer";
        choice.append(correct);
      }
      choice.append(count);
      const voters = document.createElement("div");
      voters.className = "response-voters";
      if (votersForOption.length === 0) {
        const empty = document.createElement("span");
        empty.className = "no-voters";
        empty.textContent = "Nobody picked this";
        voters.append(empty);
      } else {
        const caption = document.createElement("small");
        caption.textContent = "Voted by";
        const voterList = document.createElement("div");
        voterList.className = "response-voter-list";
        voterList.replaceChildren(...votersForOption.map((voter) => {
          const name = document.createElement("span");
          const isYou = voter.participantId === state.room.you.id;
          name.className = `recap-voter${isYou ? " is-you" : ""}`;
          name.textContent = `${voter.name}${isYou ? " (you)" : ""}`;
          return name;
        }));
        voters.append(caption, voterList);
      }
      item.append(choice, voters);
      return item;
    }));
    const nonVoters = round.results.filter((result) => !result.guessParticipantId);
    if (nonVoters.length > 0) {
      const missed = document.createElement("p");
      missed.className = "recap-non-voters";
      missed.textContent = `Did not vote: ${nonVoters.map((person) => `${person.name}${person.participantId === state.room.you.id ? " (you)" : ""}`).join(", ")}`;
      tile.append(meta, prompt, guessesLabel, guesses, missed);
    } else tile.append(meta, prompt, guessesLabel, guesses);
    return tile;
  }));
  elements["final-recap"].hidden = false;
}

function renderAnswers(game) {
  const revealed = game.phase === "reveal";
  const correctOption = revealed
    ? game.options.find((option) => option.id === game.correctParticipantId)
    : null;
  elements["answer-title"].textContent = revealed
    ? `${correctOption?.name || "Someone"} wrote it.`
    : "Who wrote this prompt?";
  elements["answer-options"].replaceChildren(...game.options.map((option) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "answer-option";
    button.dataset.participantId = option.id;
    button.textContent = option.name;
    button.disabled = revealed || Boolean(game.yourVoteId);
    if (option.id === game.yourVoteId) button.classList.add("selected");
    if (revealed && option.id === game.correctParticipantId) button.classList.add("correct");
    if (revealed && option.id === game.yourVoteId && option.id !== game.correctParticipantId) button.classList.add("wrong");
    return button;
  }));

  if (!revealed) {
    elements["vote-status"].textContent = game.yourVoteId
      ? "Vote locked. Waiting for everyone else…"
      : "Pick one name. Votes cannot be changed.";
    elements["reveal-summary"].hidden = true;
    elements["round-results"].hidden = true;
    elements["next-prompt"].hidden = true;
    return;
  }

  const yourResult = game.results.find((result) => result.participantId === state.room.you.id);
  elements["vote-status"].textContent = "";
  elements["reveal-summary"].hidden = false;
  elements["reveal-summary"].className = `reveal-summary ${yourResult?.correct ? "correct" : "wrong"}`;
  elements["reveal-summary"].textContent = yourResult?.correct
    ? `You got it right! +${yourResult.points} point${yourResult.points === 1 ? "" : "s"}.`
    : yourResult?.guessParticipantId
      ? "Not quite. Better luck next round."
      : "Time ran out before you voted.";
  const names = new Map(game.options.map((option) => [option.id, option.name]));
  elements["round-results"].replaceChildren(...game.results.map((result) => {
    const item = document.createElement("li");
    item.className = result.correct ? "correct" : "wrong";
    const player = document.createElement("strong");
    player.textContent = result.name;
    const guess = document.createElement("span");
    guess.textContent = result.guessParticipantId
      ? `picked ${names.get(result.guessParticipantId) || "someone"}${result.correct ? ` · +${result.points} points` : ""}`
      : "did not vote";
    item.append(player, guess);
    return item;
  }));
  elements["round-results"].hidden = false;
  elements["next-prompt"].hidden = false;
  elements["next-prompt"].disabled = false;
}

async function advanceGame(action) {
  const button = action === "start" ? elements["start-game"] : elements["next-prompt"];
  button.disabled = true;
  showError("start-error", "");
  try {
    await api(`/api/rooms/${state.roomId}/${action}`, { method: "POST", body: "{}" });
  } catch (error) {
    if (action === "start") showError("start-error", error.message);
    else elements["vote-status"].textContent = error.message;
    button.disabled = false;
  }
}

function startCountdown(deadline) {
  stopCountdown();
  const update = () => {
    const remaining = Math.max(0, Math.ceil((Date.parse(deadline) - Date.now()) / 1000));
    elements.timer.textContent = `${remaining}s`;
    elements.timer.classList.toggle("urgent", remaining <= 10);
  };
  update();
  state.countdown = setInterval(update, 250);
}

function stopCountdown() {
  clearInterval(state.countdown);
  state.countdown = null;
  elements.timer.textContent = "";
  elements.timer.classList.remove("urgent");
}

async function api(path, options = {}, raw = false) {
  const response = await fetch(path, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) }
  });
  if (raw) return response;
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Request failed.");
  return body;
}

function show(id) {
  for (const view of document.querySelectorAll(".view")) view.hidden = view.id !== id;
}

function showError(id, message) { elements[id].textContent = message; }
function setBusy(kind, busy) { elements[`${kind}-button`].disabled = busy; }

window.addEventListener("pagehide", () => {
  stopCountdown();
  state.socket?.close();
});
