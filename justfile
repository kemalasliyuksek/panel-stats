uuid := "panel-stats@kemalasliyuksek.com"
install_dir := env_var('HOME') / ".local/share/gnome-shell/extensions" / uuid

# list the recipes
default:
    @just --list

# compile the GSettings schema; a symlinked install needs the compiled file
schemas:
    glib-compile-schemas --strict src/schemas

# unit tests for the code that does not depend on GNOME Shell
test:
    gjs -m tests/run.js

# syntax check of every module (extension.js only loads inside GNOME Shell) and of the schema
lint:
    for f in src/*.js tests/*.js tools/*.js; do node --check --input-type=module < "$f" || exit 1; done
    glib-compile-schemas --strict --dry-run src/schemas

# everything that has to pass before a commit
check: lint test

# print what the GPU sections would show, once per second
sample seconds="30":
    gjs -m tools/sample.js {{seconds}}

# print the ranking the top consumer section is taken from
top samples="5" rows="5":
    gjs -m tools/top.js {{samples}} {{rows}}

# symlink src/ into the user's extension directory; GNOME Shell loads it at the next login
install: schemas
    ln -sfn "{{justfile_directory()}}/src" "{{install_dir}}"

# build the zip for extensions.gnome.org
pack:
    gnome-extensions pack src --force --extra-source=io.js --extra-source=gpu.js --extra-source=top.js --extra-source=icons

# run the static analysis that extensions.gnome.org applies to uploads; shexli 0.2.1 segfaults
# with tree-sitter 0.26, and it needs an absolute path
shexli: pack
    uvx --with "tree-sitter==0.25.2" shexli "{{justfile_directory()}}/{{uuid}}.shell-extension.zip"
