#!/bin/bash

email_host=$1
rate_limit=$2
src=$3

burst=0
sent=0

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
