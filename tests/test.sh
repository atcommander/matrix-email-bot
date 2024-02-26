#!/bin/bash

email_host="test13"
burst=0
rate_limit=20
sent=0

read -p "Enter Path: " src

echo $src

for i in $( ls $src | grep .eml )
do

swaks --to help@altispeed.com --server $email_host:25 --from $i+pdennert@altispeed.com --data $src/$i

echo "$i"

((burst++))
((sent++))

if [ $burst -eq $rate_limit ]
then

burst=0

echo "Emails Sent: $sent"

sleep 1m

fi

done

echo "Emails Sent: $sent"
