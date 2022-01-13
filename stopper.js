const core = require("@actions/core");
const path = require("path");
const fs = require("fs-extra");
const { create } = require("@actions/artifact");
const { artifactApi } = require("./artifactApi");
const StreamZip = require("node-stream-zip");

const downloadFolder = path.join(process.env["RUNNER_TEMP"], "turbo-downloads");
const tempArchiveFolder = path.join(
  process.env["RUNNER_TEMP"],
  "turbo-archives"
);

fs.ensureDirSync(downloadFolder);
fs.ensureDirSync(tempArchiveFolder);

function pidIsRunning(pid) {
  try {
    process.kill(+pid, 0);
    return true;
  } catch (e) {
    return false;
  }
}

async function upload() {
  const list = await artifactApi.listArtifacts();
  const existingArtifacts = list.artifacts.map((artifact) => artifact.name);

  const tempDir = path.join(
    process.env["RUNNER_TEMP"] || __dirname,
    "turbo-cache"
  );

  fs.ensureDirSync(tempDir);

  core.info("Server logs:");
  core.info(
    fs.readFileSync(path.join(tempDir, "out.log"), {
      encoding: "utf8",
      flag: "r",
    })
  );

  const client = create();

  const files = fs.readdirSync(tempDir);

  const artifactFiles = files.filter((filename) => filename.endsWith(".gz"));

  core.debug(`artifact files: ${JSON.stringify(artifactFiles, null, 2)}`);

  await Promise.all(
    artifactFiles
      .map((artifactFilename) => {
        const artifactId = path.basename(
          artifactFilename,
          path.extname(artifactFilename)
        );

        return { artifactFilename, artifactId };
      })
      .filter(({ artifactId }) => !existingArtifacts.includes(artifactId))
      .map(async ({ artifactFilename, artifactId }) => {
        core.info(`Uploading ${artifactFilename}`);

        await client.uploadArtifact(
          artifactId,
          [path.join(tempDir, artifactFilename)],
          tempDir
        );

        core.info(`Uploaded ${artifactFilename} successfully`);
      })
  );
}

function stopServer() {
  const serverPID = core.getState("TURBO_LOCAL_SERVER_PID");

  core.info(`Found server pid: ${serverPID}`);

  if (serverPID && pidIsRunning(serverPID)) {
    core.info(`Killing server pid: ${serverPID}`);
    process.kill(+serverPID);
  } else {
    core.info(`Server with pid: ${serverPID} is not running`);
  }
}

async function extractArchives() {
  const archives = fs.readdirSync(tempArchiveFolder);

  return Promise.all(
    archives
      .filter((file) => file.endsWith(".zip"))
      .map(async (filename) => {
        const zip = new StreamZip.async({
          file: path.join(tempArchiveFolder, filename),
        });

        await zip.extract(null, downloadFolder);
        await zip.close();
      })
  );
}

async function downloadArtifacts() {
  const list = await artifactApi.listArtifacts();

  await Promise.all(
    list.artifacts.map((artifact) => {
      return new Promise((resolve) => {
        artifactApi.downloadArtifact(artifact.id).then((response) => {
          const writeStream = fs.createWriteStream(
            path.join(tempArchiveFolder, `${artifact.name}.zip`)
          );

          response.data.pipe(writeStream);
          writeStream.on("finish", () => {
            resolve();
          });

          writeStream.on("error", (error) => {
            core.error(error);
            resolve();
          });
        });
      });
    })
  );

  await extractArchives();
}

async function stopper() {
  // await downloadArtifacts();

  // const files = fs.readdirSync(downloadFolder);
  //
  // (files || []).forEach((file) => {
  //   const stats = fs.statSync(path.join(downloadFolder, file));
  //   core.info(`${file} -> ${stats.size}`);
  // });

  stopServer();

  await upload();
}

stopper().catch((error) => {
  core.error(error);
  core.setFailed(`Stop server failed due to ${error}.`);
});
