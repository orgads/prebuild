#!/usr/bin/env node

var gyp = require('node-gyp')()
var path = require('path')
var install = require('node-gyp-install')
var minimist = require('minimist')
var log = require('npmlog')
var zlib = require('zlib')
var tar = require('tar-stream')
var fs = require('fs')

log.heading = 'prebuild'
var setupLog = log.info.bind(log, 'setup')

var NODE_GYP = path.join(process.env.HOME || process.env.USER_PROFILE, '.node-gyp')
var pkg = require(path.resolve('package.json'))

var argv = minimist(process.argv, {
  alias: {target: 't', help: 'h', arch: 'a', platform: 'p'},
  default: {target: process.version, arch: process.arch, platform: process.platform}
})

if (argv.help) {
  console.error(fs.readFileSync(path.join(__dirname, 'help.txt'), 'utf-8'))
  process.exit(0)
}

var targets = [].concat(argv.target)

prebuild()

function getAbi (version, cb) {
  version = version.replace('v', '')
  fs.readFile(path.join(NODE_GYP, version, 'src/node_version.h'), 'utf-8', function (err, a) {
    if (err && err.code === 'ENOENT') retry()
    if (err) return cb(err)
    fs.readFile(path.join(NODE_GYP, version, 'src/node.h'), 'utf-8', function (err, b) {
      if (err && err.code === 'ENOENT') retry()
      if (err) return cb(err)
      cb(null, parse(a) || parse(b))
    })
  })

  function retry () {
    install({log: setupLog, version: version, force: true}, function (err) {
      if (err) return cb(err)
      getAbi(version, cb)
    })
  }

  function parse (file) {
    var res = file.match(/#define\s+NODE_MODULE_VERSION\s+(\d+)/)
    return res && res[1]
  }
}


function build (version, cb) {
  var release = 'build/Release'

  install({log: setupLog, version: version}, function (err) {
    if (err) return cb(err)
    runGyp()
  })

  function runGyp () {
    gyp.parseArgv(['node', 'index.js', 'rebuild', '--target=' + version, '--target_arch=ia32'])
    gyp.commands.rebuild(gyp.todo.shift().args, function run (err) {
      if (err) return cb(err)
      if (!gyp.todo.length) return done()
      if (gyp.todo[0].name === 'configure') configurePreGyp()
      gyp.commands[gyp.todo[0].name](gyp.todo.shift().args, run)
    })
  }

  function configurePreGyp () {
    if (pkg.binary && pkg.binary.module_name) {
      gyp.todo[0].args.push('-Dmodule_name=' + pkg.binary.module_name)
    }
    if (pkg.binary && pkg.binary.module_path) {
      release = pkg.binary.module_path
      gyp.todo[0].args.push('-Dmodule_path=' + pkg.binary.module_path)
    }
  }

  function done () {
    fs.readdir(release, function (err, files) {
      if (err) return cb(err)

      for (var i = 0; i < files.length; i++) {
        if (/\.node$/i.test(files[i])) return cb(null, path.join(release, files[i]), files[i])
      }

      cb(new Error('Could not find build in build/Release'))
    })
  }
}

function prebuild () {
  var v = targets.shift()
  if (!v) return
  if (v[0] !== 'v') v = 'v' + v
  log.info('setup', 'Preparing to prebuild ' + pkg.name + '@' + pkg.version + ' for ' + v + ' on ' + argv.platform + '-' + argv.arch)
  build(v, function (err, filename) {
    if (err) return log.error(err.message)
    getAbi(v, function (err, abi) {
      if (err) return log.error(err.message)
      pack(filename, abi)
    })
  })

  function pack (filename, abi) {
    var tarPath = path.join('prebuilds', pkg.name + '-' + pkg.version + '-node-v' + abi + '-' + argv.platform + '-' + argv.arch + '.tar.gz')
    fs.mkdir('prebuilds', function () {
      fs.stat(filename, function (err, st) {
        if (err) return log.error(err.message)

        var pack = tar.pack()
        var ws = fs.createWriteStream(tarPath)
        var stream = pack.entry({
          name: filename,
          size: st.size,
          mode: st.mode,
          gid: process.getgid(),
          uid: process.getuid()
        })

        fs.createReadStream(filename).pipe(stream).on('finish', function () {
          pack.finalize()
        })

        pack.pipe(zlib.createGzip()).pipe(ws).on('close', function () {
          log.info('package', 'Prebuild written to ' + tarPath)
          prebuild()
        })
      })
    })
  }
}
