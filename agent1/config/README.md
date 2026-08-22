snmp download in linux 

sudo nano /etc/snmp/snmpd.conf

Find the line that says agentAddress udp:127.0.0.1:161.

Change it to:

Bash

agentAddress udp:161,udp6:[::1]:161

croll down and find the section for Access Control. Add this line:

Bash

rocommunity public default


3. Restart and Verify
Now, restart the service to apply changes:

Bash

sudo systemctl restart snmpd

chnage router name with yours  routers:
  - name: "ThinkPad-Test-Host"
    ip: "127.0.0.1"
    port: 161
    version: "2c"
    community: "public"
    enabled: true
    poll_interval: 10
    metrics:
      uptime: "1.3.6.1.2.1.1.3.0"
      sysDescr: "1.3.6.1.2.1.1.1.0"
      # Standard Linux/Host OIDs
      interface_in: "1.3.6.1.2.1.2.2.1.10"
      interface_out: "1.3.6.1.2.1.2.2.1.16"
      
      
      
      
      snmpwalk -v 2c -c public localhost 1.3.6.1.2.1.1.1.0
      
      
      
      and npm start agent then test on localhost
      
      
