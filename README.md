# conflibot

:warning: Development in progress -- interfaces and behavior may change until v1 gets released.

Check and warn if a Pull Request will conflict with another Pull Request when they get merged.

## Configuration

```yaml
name: conflibot
on: pull_request

jobs:
  conflibot:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      - name: Post conflict warnings
        uses: wktk/conflibot@v0.1.0
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

## Screenshots

![](./misc/checks.png)
![](./misc/details.png)
