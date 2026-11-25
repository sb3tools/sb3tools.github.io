/*
REMOVE THIS BEFORE PROD!
HOW TO COMPLETELY BYPASS THIS DETECTOR

1: Include metadata proving it was a LLM who created it (critial oversight in the code makes the score LOWER if there's LLM metadata)
2: List, block, and variable ids should be numbers, starting at 1, and continuing 2, 3, 4... (detector gives very human score if it sees this)
3: List, block, and variable ids should have a length < 20
4: Overlapping scripts can cause LOTS of false negatives (more likely to be evaluated as 'human')
5: Block & comment coordinates with a consistent amount of decimal places seem human to the detector,
   as it flags it as normal behavior in the editor
6: Repetition seems to be the detector's weakness, as it is harder to detect traces of AI when
   one snippet of code just keeps repeating over and over
7: Speaking of code analysis, it seems that the more blocks a project has, the harder it is
   for the analyzer in the detector to find traces of AI, probably because it has more options to consider
   when finding patterns

NOTE: API needs to be fixed ASAP, these methods to bypass the detector cannot persist
*/


const API_URL = "https://scratch-ai-detector.vercel.app/";

const uploadBtn = document.querySelector("#project-upload");
const loadBtn = document.querySelector("#project-load");
const linkInput = document.querySelector("#project-link");
const output = document.querySelector("#score-result");
const progress = document.querySelector("#processing-progress");

const pieSlice = document.querySelector("#pie-slice");
const scoreFraction = document.querySelector("#score-fraction");
const verdict = document.querySelector("#verdict");

const resultsTableBody = document.querySelector("#results-table tbody");

let progressTarget = progress.value;
let progressAnimationFrame = null;
let progressAnimationWaiters = [];

const animateProgress = () => {
	const difference = progressTarget - progress.value;
	if (Math.abs(difference) < 0.01) {
		progress.value = progressTarget;
		progressAnimationFrame = null;
		progressAnimationWaiters.forEach((resolve) => resolve());
		progressAnimationWaiters = [];
		return;
	}

	progress.value += Math.sign(difference) * Math.min(Math.abs(difference), 1);
	progressAnimationFrame = requestAnimationFrame(animateProgress);
};

const setProgress = (value, instant = false) => {
	progressTarget = value;
	if (instant) {
		progress.value = value
 	} else {
		if (progressAnimationFrame === null) {
			progressAnimationFrame = requestAnimationFrame(animateProgress);
		}
	}
};

const waitForProgress = () =>
	new Promise((resolve) => {
		if (progressAnimationFrame === null) {
			resolve();
		} else {
			progressAnimationWaiters.push(resolve);
		}
	});

const setBusy = (busy) => {
	uploadBtn.disabled = busy;
	loadBtn.disabled = busy;
	progress.hidden = !busy;
	if (busy) setProgress(0);
};

const showError = (error) => {
	console.error(error);
	output.textContent = `Error: ${error instanceof Error ? error.message : String(error)}`;
};

const resetResults = () => {
	pieSlice.style.setProperty("--percent", 0);
	pieSlice.style.setProperty("--color", "green");
	pieSlice.classList.remove("negative");

	scoreFraction.textContent = "0 / 0 ACS";
	verdict.textContent = "Waiting...";

	resultsTableBody.innerHTML =
		"<tr><td>N/A</td><td>N/A</td><td>N/A</td></tr>";
};

const outputResults = (result) => {
	const bandMap = {
		"Likely AI": "red",
		Suspicious: "#ffcc00",
		Inconclusive: "gray",
		"Likely human": "green",
	};

	result["contributions"].sort(function (a, b) {
		return b["units"] - a["units"];
	});

	console.log(result);

	const percent = (result["units"] / result["measurable_units"]) * 100;
	pieSlice.style.setProperty("--percent", Math.abs(percent));
	pieSlice.classList.toggle("negative", percent < 0);
	pieSlice.style.setProperty("--color", bandMap[result["band"]]);

	scoreFraction.textContent = `${result["units"]} / ${result["measurable_units"]} ACS`;
	verdict.textContent = result["band"];

	// populate results table
	resultsTableBody.replaceChildren();
	result["contributions"].forEach(appendContribution);
};

const appendContribution = (contribution) => {
	const row = document.createElement("tr");

	const testName = document.createElement("td");
	const testScore = document.createElement("td");
	const testNotes = document.createElement("td");

	testName.textContent = contribution["name"];
	testScore.textContent = `${contribution["units"]} / ${contribution["max_score"]}`;
	testNotes.textContent = contribution["note"];

	row.appendChild(testName);
	row.appendChild(testScore);
	row.appendChild(testNotes);

	resultsTableBody.appendChild(row);
};

const scoreProject = async (payload) => {
	const body = JSON.stringify({ ...payload, stream: true });
	const bodySize = new TextEncoder().encode(body).byteLength;

	// leave room under typical serverless request-body limits
	if (bodySize > 4 * 1024 * 1024)
		throw new Error(
			"Upload is too large for the API. Try loading it by a Scratch project link instead.",
		);

	setProgress(0, true);
	const response = await fetch(API_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body,
	});

	if (!response.ok) {
		let data;
		try {
			data = await response.json();
		} catch {
			throw new Error(`API request failed (HTTP ${response.status}).`);
		}
		throw new Error(
			data.error || `API request failed (HTTP ${response.status}).`,
		);
	}

	if (!response.body)
		throw new Error("API response did not contain a stream.");

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let resultReceived = false;
	let hasStreamedContribution = false;

	const handleEvent = (eventText) => {
		let event = "message";
		const dataLines = [];

		for (const line of eventText.split(/\r\n|\r|\n/)) {
			if (line.startsWith("event:")) {
				event = line.slice(6).trim();
			} else if (line.startsWith("data:")) {
				dataLines.push(line.slice(5).replace(/^ /, ""));
			}
		}

		if (dataLines.length === 0) return;

		let data;
		try {
			data = JSON.parse(dataLines.join("\n"));
		} catch {
			throw new Error("API returned an invalid streaming response.");
		}

		if (event === "progress") {
			const stage =
				typeof data.stage === "string" ? data.stage : "Scoring project";
			const stageLabel = stage.charAt(0).toUpperCase() + stage.slice(1);
			const detail =
				typeof data.detail === "string" ? `: ${data.detail}` : "";
			if (
				Number.isFinite(data.completed) &&
				Number.isFinite(data.total) &&
				data.total > 0
			) {
				const [start, end] =
					stage === "downloading"
						? [0, 30]
						: stage === "analyzing"
							? [30, 60]
							: stage === "scoring"
							? [60, 99]
							: [30, 99];
				setProgress(
					Math.min(
						end,
						Math.max(
							start,
							start +
								Math.round(
									((end - start) * data.completed) /
										data.total,
								),
						),
					),
				);
				output.textContent = `${stageLabel}${detail} (${data.completed}/${data.total})...`;
			} else {
				output.textContent = `${stageLabel}${detail}...`;
			}

			if (data.contribution) {
				if (!hasStreamedContribution) {
					resultsTableBody.replaceChildren();
					hasStreamedContribution = true;
				}
				appendContribution(data.contribution);
			}
		} else if (event === "result") {
			if (!data.result)
				throw new Error("API response did not contain a score.");
			outputResults(data.result);
			setProgress(100);
			output.textContent = "Done, see results below.";
			resultReceived = true;
		} else if (event === "error") {
			throw new Error(
				data.error || "API failed while scoring the project.",
			);
		}
	};

	try {
		while (true) {
			const { value, done } = await reader.read();
			buffer += decoder.decode(value, { stream: !done });

			const events = buffer.split(/\r\n\r\n|\n\n|\r\r/);
			buffer = events.pop();
			events.forEach(handleEvent);

			if (done) {
				if (buffer.trim()) handleEvent(buffer);
				break;
			}
		}
	} finally {
		reader.releaseLock();
	}

	if (!resultReceived) throw new Error("API stream ended without a score.");
	await waitForProgress();
	await new Promise((resolve) => setTimeout(resolve, 500));
};

const processSb3 = async (file) => {
	if (typeof JSZip === "undefined") {
		throw new Error("JSZip is not loaded.");
	}

	setProgress(5);
	const zip = await JSZip.loadAsync(file);
	setProgress(10);
	const projectFile = zip.file("project.json");

	if (!projectFile) {
		throw new Error("Invalid SB3 file: project.json not found.");
	}

	const project = JSON.parse(await projectFile.async("string"));
	if (!project || typeof project !== "object" || Array.isArray(project)) {
		throw new Error("project.json must contain a JSON object.");
	}
	setProgress(15);

	const assets = {};
	const assetFiles = Object.values(zip.files).filter(
		(entry) => !entry.dir && entry.name !== "project.json",
	);
	for (const [index, entry] of assetFiles.entries()) {
		assets[entry.name] = await entry.async("base64");
		setProgress(15 + Math.round((15 * (index + 1)) / assetFiles.length));
	}
	if (assetFiles.length === 0) setProgress(30);

	return { project, assets };
};

const openFileDialog = () => {
	const input = document.createElement("input");
	input.type = "file";
	input.accept = ".sb3";

	input.addEventListener(
		"change",
		async () => {
			const file = input.files?.[0];
			input.remove();
			if (!file) return;

			setBusy(true);
			output.textContent = `Reading ${file.name}...`;
			resetResults();

			try {
				setProgress(2);
				output.textContent = "Scoring project...";
				const payload = await processSb3(file);
				await scoreProject(payload);
			} catch (error) {
				showError(error);
			} finally {
				setBusy(false);
			}
		},
		{ once: true },
	);

	input.click();
};

const getScratchProjectId = (value) => {
	const input = value.trim();
	if (/^\d+$/.test(input)) return input;

	// bunch of validation checks
	let url;
	try {
		url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
	} catch {
		throw new Error("Enter a Scratch project ID or project link.");
	}

	if (!["scratch.mit.edu", "www.scratch.mit.edu"].includes(url.hostname)) {
		throw new Error("The link must be a Scratch project link.");
	}

	const match = url.pathname.match(/^\/projects\/(\d+)(?:\/editor)?\/?$/);
	if (!match) {
		throw new Error("Could not find a project ID in that Scratch link.");
	}

	return match[1];
};

uploadBtn.addEventListener("click", openFileDialog);

loadBtn.addEventListener("click", async () => {
	setBusy(true);
	output.textContent = "Loading project...";
	resetResults();

	try {
		const project_id = getScratchProjectId(linkInput.value);
		setProgress(30);
		output.textContent = "Scoring project...";
		await scoreProject({ project_id });
		output.textContent = "Done, see results below.";
	} catch (error) {
		showError(error);
	} finally {
		setBusy(false);
	}
});
