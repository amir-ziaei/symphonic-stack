const { execSync } = require('child_process')
const crypto = require('crypto')
const fs = require('fs/promises')
const path = require('path')

const toml = require('@iarna/toml')
const PackageJson = require('@npmcli/package-json')
const semver = require('semver')
const YAML = require('yaml')

const cleanupDeployWorkflow = (deployWorkflow, deployWorkflowPath) => {
  delete deployWorkflow.jobs.typecheck
  deployWorkflow.jobs.deploy.needs = deployWorkflow.jobs.deploy.needs.filter(
    need => need !== 'typecheck',
  )

  return [fs.writeFile(deployWorkflowPath, YAML.stringify(deployWorkflow))]
}

const cleanupVitestConfig = (vitestConfig, vitestConfigPath) => {
  const newVitestConfig = vitestConfig.replace(
    'setup-test-env.ts',
    'setup-test-env.js',
  )

  return [fs.writeFile(vitestConfigPath, newVitestConfig)]
}

const escapeRegExp = string =>
  // $& means the whole matched string
  string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const getPackageManagerCommand = packageManager =>
  // Inspired by https://github.com/nrwl/nx/blob/bd9b33eaef0393d01f747ea9a2ac5d2ca1fb87c6/packages/nx/src/utils/package-manager.ts#L38-L103
  ({
    npm: () => ({
      exec: 'npx',
      lockfile: 'package-lock.json',
      run: (script, args) => `npm run ${script} ${args ? `-- ${args}` : ''}`,
    }),
    pnpm: () => {
      const pnpmVersion = getPackageManagerVersion('pnpm')
      const includeDoubleDashBeforeArgs = semver.lt(pnpmVersion, '7.0.0')
      const useExec = semver.gte(pnpmVersion, '6.13.0')

      return {
        exec: useExec ? 'pnpm exec' : 'pnpx',
        lockfile: 'pnpm-lock.yaml',
        run: (script, args) =>
          includeDoubleDashBeforeArgs
            ? `pnpm run ${script} ${args ? `-- ${args}` : ''}`
            : `pnpm run ${script} ${args || ''}`,
      }
    },
    yarn: () => ({
      exec: 'yarn',
      lockfile: 'yarn.lock',
      run: (script, args) => `yarn ${script} ${args || ''}`,
    }),
  }[packageManager]())

const getPackageManagerVersion = packageManager =>
  // Copied over from https://github.com/nrwl/nx/blob/bd9b33eaef0393d01f747ea9a2ac5d2ca1fb87c6/packages/nx/src/utils/package-manager.ts#L105-L114
  execSync(`${packageManager} --version`).toString('utf-8').trim()

const getRandomString = length => crypto.randomBytes(length).toString('hex')

const readFileIfNotTypeScript = (
  isTypeScript,
  filePath,
  parseFunction = result => result,
) =>
  isTypeScript
    ? Promise.resolve()
    : fs.readFile(filePath, 'utf-8').then(parseFunction)

const removeUnusedDependencies = (dependencies, unusedDependencies) =>
  Object.fromEntries(
    Object.entries(dependencies).filter(
      ([key]) => !unusedDependencies.includes(key),
    ),
  )

const updatePackageJson = ({ APP_NAME, isTypeScript, packageJson }) => {
  const {
    devDependencies,
    scripts: { typecheck, validate, ...scripts },
  } = packageJson.content

  packageJson.update({
    name: APP_NAME,
    devDependencies: isTypeScript
      ? devDependencies
      : removeUnusedDependencies(devDependencies, ['ts-node']),
    scripts: isTypeScript
      ? { ...scripts, typecheck, validate }
      : { ...scripts, validate: validate.replace(' typecheck', '') },
  })
}

const main = async ({ isTypeScript, packageManager, rootDirectory }) => {
  const pm = getPackageManagerCommand(packageManager)
  const FILE_EXTENSION = isTypeScript ? 'ts' : 'js'

  const README_PATH = path.join(rootDirectory, 'README.md')
  const FLY_TOML_PATH = path.join(rootDirectory, 'fly.toml')
  const DEPLOY_WORKFLOW_PATH = path.join(
    rootDirectory,
    '.github',
    'workflows',
    'deploy.yml',
  )
  const DOCKERFILE_PATH = path.join(rootDirectory, 'Dockerfile')
  const VITEST_CONFIG_PATH = path.join(
    rootDirectory,
    `vitest.config.${FILE_EXTENSION}`,
  )

  const REPLACER = 'symphonic-stack-template'

  const DIR_NAME = path.basename(rootDirectory)
  const SUFFIX = getRandomString(2)

  const APP_NAME = (DIR_NAME + '-' + SUFFIX)
    // get rid of anything that's not allowed in an app name
    .replace(/[^a-zA-Z0-9-_]/g, '-')

  const [
    prodContent,
    readme,
    dockerfile,
    deployWorkflow,
    vitestConfig,
    packageJson,
  ] = await Promise.all([
    fs.readFile(FLY_TOML_PATH, 'utf-8'),
    fs.readFile(README_PATH, 'utf-8'),
    fs.readFile(DOCKERFILE_PATH, 'utf-8'),
    readFileIfNotTypeScript(isTypeScript, DEPLOY_WORKFLOW_PATH, s =>
      YAML.parse(s),
    ),
    readFileIfNotTypeScript(isTypeScript, VITEST_CONFIG_PATH),
    PackageJson.load(rootDirectory),
  ])

  const prodToml = toml.parse(prodContent)
  prodToml.app = prodToml.app.replace(REPLACER, APP_NAME)

  const newReadme = readme.replace(
    new RegExp(escapeRegExp(REPLACER), 'g'),
    APP_NAME,
  )

  const newDockerfile = pm.lockfile
    ? dockerfile.replace(
        new RegExp(escapeRegExp('ADD package.json'), 'g'),
        `ADD package.json ${pm.lockfile}`,
      )
    : dockerfile

  updatePackageJson({ APP_NAME, isTypeScript, packageJson })

  const fileOperationPromises = [
    fs.writeFile(FLY_TOML_PATH, toml.stringify(prodToml)),
    fs.writeFile(README_PATH, newReadme),
    fs.writeFile(DOCKERFILE_PATH, newDockerfile),
    packageJson.save(),
    fs.copyFile(
      path.join(rootDirectory, 'remix.init', 'gitignore'),
      path.join(rootDirectory, '.gitignore'),
    ),
    fs.rm(path.join(rootDirectory, '.github', 'dependabot.yml')),
  ]

  if (!isTypeScript) {
    fileOperationPromises.push(
      ...cleanupDeployWorkflow(deployWorkflow, DEPLOY_WORKFLOW_PATH),
    )

    fileOperationPromises.push(
      ...cleanupVitestConfig(vitestConfig, VITEST_CONFIG_PATH),
    )
  }

  await Promise.all(fileOperationPromises)

  execSync(pm.run('format', '--loglevel warn'), {
    cwd: rootDirectory,
    stdio: 'inherit',
  })

  console.log(
    `Setup is complete. You're now ready to rock and roll 🤘

Start development with \`${pm.run('dev')}\`
    `.trim(),
  )
}

module.exports = main
