"""Build DuckDB 2.0's Python wheel for x86-64 servers without AVX2 or BMI2.

The wheel links `excel` and `postgres` statically, at the revisions the DuckDB release
pins, so neither is downloaded or loaded from a binary built for newer processors.
Their dependencies are built from verified sources with baseline x86-64 flags, except
OpenSSL, which comes from the build host's static libraries (Debian's libssl-dev).
`postgres_scanner-gcc12.patch` lets GCC 12 compile the pinned `postgres` revision; it
changes no behavior.

Run with a Python environment providing scikit-build-core, nanobind, numpy, CMake and
Ninja; `scripts/provision-runtime.sh` prepares it. The build host needs a C/C++
compiler, Git, make, Perl, bison, flex and libssl-dev. DUCKPAD_BUILD_SOURCE may point
to an unpacked, verified DuckDB sdist with a previous build directory, so that only
changed objects compile again.

Usage: python scripts/build_runtime.py <output directory>
"""

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tomllib
import urllib.request
from pathlib import Path

VERSION = "2.0.0"
FLAGS = "-march=x86-64 -mtune=generic"
REPOSITORY = Path(__file__).resolve().parents[1]
CACHE = Path.home() / ".cache/duckpad-build"
WORK = CACHE / "runtime"
PREFIX = WORK / "dependencies"
SOURCE = Path(os.environ.get("DUCKPAD_BUILD_SOURCE", str(CACHE / f"duckdb-{VERSION}")))
JOBS = os.environ.get("CMAKE_BUILD_PARALLEL_LEVEL", "4")
LINKED = ["core_functions", "json", "parquet", "icu", "excel", "postgres_scanner"]


def run(*args, cwd=None, env=None):
    print("+", *map(str, args), flush=True)
    subprocess.run(list(map(str, args)), cwd=cwd, env=env, check=True)


def download(url, path, digest, algorithm="sha512"):
    if not path.exists():
        temporary = path.with_suffix(".download")
        with urllib.request.urlopen(url, timeout=60) as response, temporary.open("wb") as target:
            shutil.copyfileobj(response, target)
        temporary.replace(path)
    if hashlib.new(algorithm, path.read_bytes()).hexdigest() != digest:
        raise RuntimeError(f"Source checksum mismatch: {path}")


def unpack(archive, name):
    target = WORK / f"{name}-source"
    if not target.exists():
        target.mkdir()
        with tarfile.open(archive) as package:
            package.extractall(target, filter="data")
    return next(target.iterdir())


def pin(extension):
    """The Git repository, revision and submodules the DuckDB release builds an extension from."""
    text = (SOURCE / f"external/duckdb/.github/config/extensions/{extension}.cmake").read_text()
    submodules = re.search(r"SUBMODULES\s+([\w-]+)", text)
    return (
        re.search(r"GIT_URL\s+(\S+)", text)[1],
        re.search(r"GIT_TAG\s+([0-9a-f]{40})", text)[1],
        submodules[1].split(";") if submodules else [],
    )


def checkout(extension):
    """The extension's source at the DuckDB release pin, with this repository's patches applied."""
    url, revision, submodules = pin(extension)
    target = CACHE / extension
    if not target.exists():
        run("git", "clone", "--filter=blob:none", "--no-checkout", url, target)
        run("git", "-C", target, "checkout", "--detach", revision)
        for submodule in submodules:
            run("git", "-C", target, "submodule", "update", "--init", "--filter=blob:none", submodule)
    head = subprocess.check_output(["git", "-C", str(target), "rev-parse", "HEAD"], text=True).strip()
    if head != revision:
        raise RuntimeError(f"{extension} checkout must match the DuckDB release pin")
    patch = Path(__file__).with_name(f"{extension}-gcc12.patch")
    run("git", "-C", target, "checkout", "--", ".")
    if patch.exists():
        run("git", "-C", target, "apply", patch)
    return target, revision


def port(extension, name):
    """Version and SHA512 of a dependency, as pinned by the extension's vcpkg port."""
    directory = extension / "vcpkg_ports" / name
    portfile = (directory / "portfile.cmake").read_text()
    version = json.loads((directory / "vcpkg.json").read_text()).get("version")
    return version, re.search(r"SHA512\s+([a-f0-9]{128})", portfile)[1]


def github_dependency(extension, name, repository, ref):
    _, digest = port(extension, name)
    archive = WORK / f"{name}-{ref}.tar.gz"
    download(f"https://codeload.github.com/{repository}/tar.gz/{ref}", archive, digest)
    return unpack(archive, name)


def cmake(source, name, *options):
    build = WORK / f"{name}-build"
    run(
        "cmake",
        "-S",
        source,
        "-B",
        build,
        "-G",
        "Ninja",
        "-DCMAKE_BUILD_TYPE=Release",
        f"-DCMAKE_INSTALL_PREFIX={PREFIX}",
        f"-DCMAKE_PREFIX_PATH={PREFIX}",
        "-DCMAKE_POSITION_INDEPENDENT_CODE=ON",
        f"-DCMAKE_C_FLAGS={FLAGS}",
        f"-DCMAKE_CXX_FLAGS={FLAGS}",
        *options,
    )
    run("cmake", "--build", build, "--parallel", JOBS)
    run("cmake", "--install", build)


def libpq(postgres):
    """Static, position-independent libpq with OpenSSL, for the client side only."""
    version, digest = port(postgres, "libpq")
    archive = WORK / f"postgresql-{version}.tar.bz2"
    download(
        f"https://ftp.postgresql.org/pub/source/v{version}/postgresql-{version}.tar.bz2", archive, digest
    )
    source = unpack(archive, "postgresql")
    if not (PREFIX / "lib/libpq.a").exists():
        environment = {**os.environ, "CFLAGS": f"{FLAGS} -O2 -fPIC"}
        run(
            "./configure",
            f"--prefix={PREFIX}",
            "--with-ssl=openssl",
            "--disable-nls",
            *(
                f"--without-{feature}"
                for feature in ("readline", "icu", "zlib", "lz4", "zstd", "gssapi", "ldap", "pam")
            ),
            cwd=source,
            env=environment,
        )
        for directory in ("src/interfaces/libpq", "src/include", "src/common", "src/port"):
            run("make", "-C", directory, "-j", JOBS, "install", cwd=source, env=environment)
    return version


def static_library(name):
    path = Path(subprocess.check_output(["cc", f"-print-file-name={name}"], text=True).strip())
    if not path.is_absolute():
        raise RuntimeError(f"{name} is missing: install the static OpenSSL libraries (libssl-dev)")
    return path


def main():
    output = Path(sys.argv[1]).resolve()
    WORK.mkdir(parents=True, exist_ok=True)
    output.mkdir(parents=True, exist_ok=True)
    os.environ.update(CFLAGS=FLAGS, CXXFLAGS=FLAGS, CMAKE_BUILD_PARALLEL_LEVEL=JOBS)
    os.environ["PATH"] = str(Path(sys.executable).parent) + os.pathsep + os.environ["PATH"]

    lock = tomllib.loads((REPOSITORY / "uv.lock").read_text())
    package = next(p for p in lock["package"] if p["name"] == "duckdb")
    assert package["version"] == VERSION, "Update the runtime image and provisioning version together."
    archive_path = CACHE / f"duckdb-{VERSION}.tar.gz"
    download(
        package["sdist"]["url"], archive_path, package["sdist"]["hash"].removeprefix("sha256:"), "sha256"
    )
    if not SOURCE.exists():
        with tarfile.open(archive_path) as archive:
            archive.extractall(CACHE, filter="data")
    with tarfile.open(archive_path) as archive:
        for member in archive:
            relative = Path(*Path(member.name).parts[1:])
            if not member.isfile() or "__pycache__" in relative.parts:
                continue
            target = SOURCE / relative
            reader = archive.extractfile(member)
            if not target.exists() or reader is None or target.read_bytes() != reader.read():
                raise RuntimeError(f"DuckDB source differs from the verified release: {relative}")

    excel, excel_revision = checkout("excel")
    postgres, postgres_revision = checkout("postgres_scanner")
    zlib = github_dependency(excel, "zlib", "madler/zlib", "v1.3.1")
    expat = github_dependency(excel, "expat", "libexpat/libexpat", "R_2_6_4")
    minizip = github_dependency(excel, "minizip-ng", "zlib-ng/minizip-ng", "4.0.7")
    cmake(zlib, "zlib", "-DZLIB_BUILD_EXAMPLES=OFF")
    cmake(
        expat / "expat",
        "expat",
        "-DEXPAT_SHARED_LIBS=OFF",
        "-DEXPAT_BUILD_EXAMPLES=OFF",
        "-DEXPAT_BUILD_TESTS=OFF",
        "-DEXPAT_BUILD_TOOLS=OFF",
        "-DEXPAT_BUILD_DOCS=OFF",
    )
    cmake(
        minizip,
        "minizip",
        "-DBUILD_SHARED_LIBS=OFF",
        "-DMZ_LIB_SUFFIX=-ng",
        "-DMZ_FETCH_LIBS=OFF",
        "-DMZ_ZLIB=ON",
        f"-DZLIB_LIBRARY={PREFIX}/lib/libz.a",
        f"-DZLIB_INCLUDE_DIR={PREFIX}/include",
        *(
            f"-DMZ_{option}=OFF"
            for option in ("BZIP2", "LZMA", "ZSTD", "PKCRYPT", "WZAES", "OPENSSL", "ICONV")
        ),
        "-DMZ_BUILD_TESTS=OFF",
        "-DMZ_BUILD_UNIT_TESTS=OFF",
    )
    libpq_version = libpq(postgres)
    ssl, crypto = static_library("libssl.a"), static_library("libcrypto.a")
    openssl = subprocess.check_output(["openssl", "version"], text=True).split()[1]

    configuration = WORK / "extension_config.cmake"
    configuration.write_text(
        f"duckdb_extension_load(excel SOURCE_DIR {excel} INCLUDE_DIR {excel}/src/excel/include)\n"
        f"duckdb_extension_load(postgres_scanner SOURCE_DIR {postgres})\n"
    )
    # The static extension does not declare its libraries; append them to every link,
    # and keep their symbols out of the module's exports, away from Python's own OpenSSL.
    libraries = [
        PREFIX / "lib/libpq.a",
        PREFIX / "lib/libpgcommon_shlib.a",
        PREFIX / "lib/libpgport_shlib.a",
        ssl,
        crypto,
    ]
    os.chdir(SOURCE)
    sys.path.insert(0, str(SOURCE))
    from duckdb_packaging.build_backend import build_wheel

    wheel = build_wheel(
        str(output),
        {
            "cmake.define.DUCKDB_OPTIMIZATION_PROFILE": "NONE",
            "cmake.define.BUILD_EXTENSIONS": ";".join(LINKED),
            "cmake.define.DUCKDB_EXTENSION_CONFIGS": str(configuration),
            "cmake.define.CMAKE_PREFIX_PATH": str(PREFIX),
            "cmake.define.ZLIB_LIBRARY": str(PREFIX / "lib/libz.a"),
            "cmake.define.ZLIB_INCLUDE_DIR": str(PREFIX / "include"),
            "cmake.define.EXPAT_LIBRARY": str(PREFIX / "lib/libexpat.a"),
            "cmake.define.EXPAT_INCLUDE_DIR": str(PREFIX / "include"),
            "cmake.define.PostgreSQL_INCLUDE_DIR": str(PREFIX / "include"),
            "cmake.define.PostgreSQL_TYPE_INCLUDE_DIR": str(PREFIX / "include/server"),
            "cmake.define.PostgreSQL_LIBRARY": str(PREFIX / "lib/libpq.a"),
            "cmake.define.OPENSSL_USE_STATIC_LIBS": "TRUE",
            "cmake.define.CMAKE_CXX_STANDARD_LIBRARIES": " ".join(map(str, libraries)) + " -lpthread -ldl",
            "cmake.define.CMAKE_MODULE_LINKER_FLAGS": "-Wl,--exclude-libs,ALL",
            "cmake.define.CMAKE_SHARED_LINKER_FLAGS": "-Wl,--exclude-libs,ALL",
        },
    )
    manifest = {
        "duckdb": VERSION,
        "optimization_profile": "NONE",
        "architecture_flags": FLAGS,
        "linked_extensions": LINKED,
        "excel_revision": excel_revision,
        "postgres_scanner_revision": postgres_revision,
        "dependencies": {
            "zlib": "1.3.1",
            "expat": "2.6.4",
            "minizip-ng": "4.0.7",
            "libpq": libpq_version,
            "openssl": f"{openssl} (static, build host)",
        },
        "wheel": wheel,
        "sha256": hashlib.sha256((output / wheel).read_bytes()).hexdigest(),
    }
    (output / "BUILD.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
