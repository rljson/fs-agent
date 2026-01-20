<!--
@license
Copyright (c) 2025 Rljson

Use of this source code is governed by terms that can be
found in the LICENSE file in the root of this package.
-->

# Install SQL Server

Make sure [docker is installed](./install-docker.md)

Pull, install and start MSSQL docker image

```bash
sudo docker run -e "ACCEPT_EULA=Y" -e "SA_PASSWORD=Password123!" -p 1433:1431 --name mssql -d mcr.microsoft.com/mssql/server:2022-latest
```

Check if it is running

```bash
sudo docker ps | grep mssql
```
